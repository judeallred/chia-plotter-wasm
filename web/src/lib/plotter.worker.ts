/// <reference lib="webworker" />
// Runs the pos2 WASM plotter and streams the finished plot file to disk.
//
// The core module is loaded on demand. k28 needs the memory64 build (about 9 GB of heap),
// smaller k sizes use the wasm32 build. Plotting itself runs on a pthread inside the
// module, so this worker stays responsive and polls for progress.

import { GpuG, pairStats, selfTest, serve, type GpuHost } from "./gpu";
import type { FromWorker, PlotJob, ToWorker } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

interface Pos2Module {
  wasmMemory: WebAssembly.Memory;
  _malloc(n: number | bigint): number | bigint;
  _free(p: number | bigint): void;
  UTF8ToString(p: number | bigint): string;
  _pos2w_set_threads(n: number): void;
  _pos2w_threads(): number;
  _pos2w_start(
    plotId: number | bigint, k: number, strength: number, index: number, metaGroup: number,
    memo: number | bigint, memoLen: number, testnet: number,
  ): number;
  _pos2w_status(): number;
  _pos2w_progress(): number;
  _pos2w_phase(): number;
  _pos2w_table(): number;
  _pos2w_timing_ms(t: number): number;
  _pos2w_error(): number | bigint;
  _pos2w_cancel(): void;
  _pos2w_pause(on: number): void;
  _pos2w_begin_write(): number;
  _pos2w_next_chunk(): number | bigint;
  _pos2w_chunk_len(): number;
  _pos2w_num_chunks(): number;
  _pos2w_header(): number | bigint;
  _pos2w_header_len(): number;
  _pos2w_reset(): void;
  _pos2w_gpu_enable(on: number): void;
  _pos2w_gpu_enabled(): number;
  _pos2w_gpu_total_ms(): number;
  _pos2w_gpu_reset_total(): void;
  _pos2w_gpu_set_pairs_mode(mode: number): void;
  _pos2w_gpu_split(table: number): number;
  _pos2w_phase_ms(table: number, phase: number): number;
}

const Status = { running: 1, plotted: 2, cancelled: -2, error: -1 } as const;
const phaseNames = ["idle", "plotting", "allocating", "matching", "sorting", "done", "error"];

const modules = new Map<string, Promise<Pos2Module>>();

function loadModule(variant: "32" | "64"): Promise<Pos2Module> {
  let m = modules.get(variant);
  if (!m) {
    const url = new URL(`/wasm/pos2w${variant}.js`, self.location.origin).href;
    m = import(/* @vite-ignore */ url).then((mod) =>
      mod.default({
        printErr: (s: string) => console.warn("[pos2w]", s),
        // Pthread workers need to load the same script.
        mainScriptUrlOrBlob: url,
      }),
    ) as Promise<Pos2Module>;
    modules.set(variant, m);
  }
  return m;
}

let cancelRequested = false;
let paused = false;
// One GPU device per worker, created on first use. undefined means not tried yet.
let gpu: GpuG | null | undefined;
let current: Pos2Module | null = null;

const post = (msg: FromWorker) => self.postMessage(msg);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FileWriter {
  write(position: number, data: Uint8Array): Promise<void>;
  close(): Promise<File | undefined>;
  abort(): Promise<void>;
}

async function openWriter(job: PlotJob): Promise<FileWriter> {
  if (job.sink.kind === "dir") {
    const handle = await job.sink.dir.getFileHandle(job.filename, { create: true });
    // createWritable writes to a swap file and only replaces the target on close, so a
    // half written plot never shows up under its final name.
    const w = await handle.createWritable({ keepExistingData: false });
    return {
      write: (position, data) => w.write({ type: "write", position, data: data as Uint8Array<ArrayBuffer> }),
      close: async () => {
        await w.close();
        return undefined;
      },
      abort: () => w.abort(),
    };
  }
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(job.filename, { create: true });
  const access = await handle.createSyncAccessHandle();
  access.truncate(0);
  return {
    write: async (position, data) => {
      let done = 0;
      while (done < data.length) {
        done += access.write(data.subarray(done), { at: position + done });
      }
    },
    close: async () => {
      access.flush();
      access.close();
      return handle.getFile();
    },
    abort: async () => {
      access.close();
      await root.removeEntry(job.filename).catch(() => {});
    },
  };
}

async function runPlot(job: PlotJob) {
  cancelRequested = false;
  paused = false;
  const t0 = performance.now();
  post({ type: "progress", phase: "loading", fraction: 0, table: 0, detail: "loading plotter" });
  const variant = job.k > 26 ? "64" : "32";
  const M = await loadModule(variant);
  current = M;
  const big = variant === "64";
  const toPtr = (n: number) => (big ? BigInt(n) : n);
  // memory64 pointers arrive as BigInt. wasm32 pointers arrive as signed i32, so anything
  // above 2 GB (k26 heaps get there) is negative unless converted with >>> 0.
  const fromPtr = (p: number | bigint) => (typeof p === "bigint" ? Number(p) : p >>> 0);

  M._pos2w_reset();
  // In hybrid mode this worker's own thread feeds the GPU while the plot threads work, so
  // leave it a core.
  M._pos2w_set_threads(job.gpu === "hybrid" ? Math.max(1, job.threads - 1) : job.threads);
  Object.assign(pairStats, { uploadMs: 0, gpuMs: 0, copyMs: 0, requests: 0 });

  // Attach the GPU for g(x) if allowed, available, and it agrees with the CPU on a sample.
  M._pos2w_gpu_enable(0);
  M._pos2w_gpu_reset_total();
  let gpuNote = job.gpu !== "off" ? "" : "GPU off in settings";
  let service: { stop(): void } | null = null;
  M._pos2w_gpu_set_pairs_mode(job.gpu === "gpu" ? 1 : job.gpu === "hybrid" ? 2 : 0);
  if (job.gpu !== "off") {
    try {
      if (gpu === undefined || gpu?.lost) gpu = await GpuG.create();
      if (!gpu) {
        gpuNote = "no WebGPU adapter";
      } else if (await selfTest(gpu, M as unknown as GpuHost, "pos2w", big, job.plotId, job.k, job.testnet, job.strength, true)) {
        service = serve(gpu, M as unknown as GpuHost, "pos2w", (m) => console.warn(m));
        M._pos2w_gpu_enable(1);
        gpuNote = gpu.adapterInfo || "GPU";
      } else {
        gpuNote = "GPU self test failed";
        gpu = null;
      }
    } catch (e) {
      gpuNote = `GPU unavailable: ${e instanceof Error ? e.message : e}`;
      gpu = null;
    }
  }

  // The heap grows on the plot thread, which leaves Emscripten's HEAPU8 view on this
  // thread pointing at the old, shorter buffer. Always build a fresh view.
  const heap = () => new Uint8Array(M.wasmMemory.buffer);
  const alloc = (bytes: Uint8Array) => {
    const p = fromPtr(M._malloc(toPtr(bytes.length)));
    heap().set(bytes, p);
    return p;
  };
  const pId = alloc(job.plotId);
  const pMemo = alloc(job.memo);
  const rc = M._pos2w_start(
    toPtr(pId), job.k, job.strength, job.plotIndex, job.metaGroup, toPtr(pMemo), job.memo.length, job.testnet ? 1 : 0,
  );
  M._free(toPtr(pId));
  M._free(toPtr(pMemo));
  if (rc !== 0) {
    M._pos2w_gpu_enable(0);
    service?.stop();
    throw new Error(`plotter rejected parameters (code ${rc})`);
  }

  while (M._pos2w_status() === Status.running) {
    await sleep(200);
    if (cancelRequested) M._pos2w_cancel();
    const table = M._pos2w_table();
    post({
      type: "progress",
      phase: "plotting",
      fraction: M._pos2w_progress(),
      table,
      detail: `${phaseNames[M._pos2w_phase()] ?? "working"}${table ? ` table ${table}` : ""}`,
      heapBytes: M.wasmMemory.buffer.byteLength,
    });
  }
  const gpuMs = M._pos2w_gpu_total_ms();
  if (service && !M._pos2w_gpu_enabled()) gpuNote = "GPU failed during the plot, finished on CPU";
  else if (service && job.gpu === "hybrid") {
    const share = [1, 2, 3].map((t) => `${Math.round(M._pos2w_gpu_split(t) * 100)}%`).join("/");
    gpuNote += `, hybrid: GPU did ${share} of tables 1/2/3`;
  }
  if (pairStats.requests) {
    const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    gpuNote += `, table pairs: ${sec(pairStats.uploadMs)} upload, ${sec(pairStats.gpuMs)} GPU, ${sec(pairStats.copyMs)} copy back`;
  }
  M._pos2w_gpu_enable(0);
  service?.stop();
  const status = M._pos2w_status();
  if (status === Status.cancelled) {
    M._pos2w_reset();
    post({ type: "cancelled" });
    return;
  }
  if (status !== Status.plotted) {
    let message = M.UTF8ToString(fromPtr(M._pos2w_error())) || `plotter failed (status ${status})`;
    if (/bad_alloc|allocation failed/i.test(message)) {
      const gb = (M.wasmMemory.buffer.byteLength / 1e9).toFixed(1);
      message = `ran out of memory with ${gb} GB in use. k${job.k} needs about ${job.k >= 28 ? "11" : "3"} GB for the plotter. Close other apps or tabs and try again.`;
    }
    M._pos2w_reset();
    throw new Error(message);
  }
  const t1 = performance.now();

  const writer = await openWriter(job);
  let file: File | undefined;
  let bytes = 0;
  try {
    const headerSize = M._pos2w_begin_write();
    if (headerSize < 0) throw new Error(M.UTF8ToString(fromPtr(M._pos2w_error())) || "failed to prepare plot");
    const numChunks = M._pos2w_num_chunks();
    // Reserve the header. It is rewritten with the real chunk offsets at the end.
    await writer.write(0, new Uint8Array(headerSize));
    let pos = headerSize;
    for (let i = 0; ; i++) {
      if (cancelRequested) throw new DOMException("cancelled", "AbortError");
      // The write loop runs here in JavaScript, so pausing it is just waiting.
      while (paused && !cancelRequested) await sleep(100);
      const p = fromPtr(M._pos2w_next_chunk());
      if (!p) break;
      const len = M._pos2w_chunk_len();
      // slice() copies out of the shared WASM heap, which file APIs do not accept.
      await writer.write(pos, heap().slice(p, p + len));
      pos += len;
      if (i % 16 === 0) {
        post({
          type: "progress", phase: "writing", fraction: i / numChunks, table: 0,
          detail: `writing chunk ${i + 1} of ${numChunks}`,
          heapBytes: M.wasmMemory.buffer.byteLength,
        });
      }
    }
    if (M._pos2w_status() < 0) throw new Error(M.UTF8ToString(fromPtr(M._pos2w_error())));
    const h = fromPtr(M._pos2w_header());
    await writer.write(0, heap().slice(h, h + M._pos2w_header_len()));
    file = await writer.close();
    bytes = pos;
  } catch (e) {
    await writer.abort().catch(() => {});
    M._pos2w_reset();
    if (e instanceof DOMException && e.name === "AbortError") {
      post({ type: "cancelled" });
      return;
    }
    throw e;
  }
  const t2 = performance.now();
  const tablesMs = [0, 1, 2, 3].map((t) => M._pos2w_timing_ms(t)) as [number, number, number, number];
  const phasesMs = [0, 1, 2, 3].map((t) => [0, 1, 2, 3, 4].map((p) => M._pos2w_phase_ms(t, p)));
  M._pos2w_reset();
  post({
    type: "done",
    filename: job.filename,
    bytes,
    file,
    timings: { totalMs: t2 - t0, plotMs: t1 - t0, writeMs: t2 - t1, tablesMs, gpuMs, gpuNote, phasesMs },
  });
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === "cancel") {
    cancelRequested = true;
    current?._pos2w_cancel();
    return;
  }
  if (msg.type === "pause") {
    paused = msg.paused;
    current?._pos2w_pause(paused ? 1 : 0);
    return;
  }
  if (msg.type === "plot") {
    runPlot(msg.job).catch((e: unknown) => {
      post({ type: "error", message: e instanceof Error ? e.message : String(e) });
    });
  }
};
