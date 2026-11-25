/// <reference lib="webworker" />
// Runs the pos2 WASM plotter and streams the finished plot group file to disk.
//
// The core module is loaded on demand. k28 needs the memory64 build (about 9 GB of heap),
// smaller k sizes use the wasm32 build. Plotting itself runs on a pthread inside the
// module, so this worker stays responsive and polls for progress.

import { type GpuAttachment, type GpuHost, type GpuWorkerState, type Pointer, attachGpu, pointerFor, ptr } from "./gpu";
import type { FromWorker, PlotJob, ToWorker } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

// Exports of pos2w32 and pos2w64. Pointers and sizes are BigInt in pos2w64 and Numbers in
// pos2w32: build arguments with pointerFor() and read results with ptr().
interface Pos2Module {
  wasmMemory: WebAssembly.Memory;
  _malloc(n: Pointer): Pointer;
  _free(p: Pointer): void;
  UTF8ToString(p: number): string;
  _pos2w_set_threads(n: number): void;
  _pos2w_threads(): number;
  _pos2w_start(
    plotGroupId: Pointer, k: number, strength: number, index: number, metaGroup: number, memo: Pointer, memoLen: number,
  ): number;
  _pos2w_status(): number;
  _pos2w_progress(): number;
  _pos2w_phase(): number;
  _pos2w_table(): number;
  _pos2w_timing_ms(t: number): number;
  _pos2w_error(): Pointer;
  _pos2w_cancel(): void;
  _pos2w_pause(on: number): void;
  _pos2w_begin_write(): number;
  _pos2w_next_piece(): Pointer;
  _pos2w_piece_len(): number;
  _pos2w_num_chunks(): number;
  _pos2w_header(): Pointer;
  _pos2w_header_len(): number;
  _pos2w_reset(): void;
  _pos2w_gpu_enable(on: number): void;
  _pos2w_gpu_total_ms(): number;
  _pos2w_gpu_reset_total(): void;
  _pos2w_gpu_set_pairs_mode(mode: number): void;
  _pos2w_gpu_split(table: number): number;
  _pos2w_phase_ms(table: number, phase: number): number;
}

// pos2w.cpp's Status values this worker checks for.
const Status = { running: 1, plotted: 2, cancelled: -2 } as const;
// pos2w::gpu::PairsMode.
const PairsMode = { off: 0, gpu: 1, hybrid: 2 } as const;
const phaseNames = ["idle", "plotting", "allocating", "matching", "sorting", "done", "error"];

const modules = new Map<string, Promise<Pos2Module>>();

function loadModule(variant: "32" | "64"): Promise<Pos2Module> {
  let m = modules.get(variant);
  if (!m) {
    const url = new URL(`${import.meta.env.BASE_URL}wasm/pos2w${variant}.js`, self.location.origin).href;
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
// Kept across plots: a pause pressed between plots holds the next one.
let paused = false;
const gpuState: GpuWorkerState = {};
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
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(job.sink.folder, { create: true });
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

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Sets the module's GPU options for this plot, then attaches the GPU unless it is off.
async function setUpGpu(M: Pos2Module, job: PlotJob): Promise<GpuAttachment> {
  M._pos2w_gpu_reset_total();
  M._pos2w_gpu_set_pairs_mode(PairsMode[job.gpu]);
  if (job.gpu === "off") {
    M._pos2w_gpu_enable(0);
    return { note: "GPU off in settings", stillEnabled: () => false, stop: () => {} };
  }
  return attachGpu(gpuState, M as unknown as GpuHost, "pos2w", {
    plotId: job.plotId, k: job.k, strength: job.strength, pairs: true, memory64: job.k > 26,
  });
}

// What the GPU did during the plot, for the history row.
function gpuSummary(M: Pos2Module, job: PlotJob, gpu: GpuAttachment): string {
  if (!gpu.stats) return gpu.note;
  if (!gpu.stillEnabled()) return "GPU failed during the plot, finished on CPU";
  let note = gpu.note;
  if (job.gpu === "hybrid") {
    const share = [1, 2, 3].map((t) => `${Math.round(M._pos2w_gpu_split(t) * 100)}%`).join("/");
    note += `, hybrid: GPU did ${share} of tables 1/2/3`;
  }
  const s = gpu.stats;
  if (s.requests) {
    const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    note += `, table pairs: ${sec(s.uploadMs)} upload, ${sec(s.gpuMs)} GPU, ${sec(s.copyMs)} copy back`;
  }
  return note;
}

async function runPlot(job: PlotJob) {
  cancelRequested = false;
  const t0 = performance.now();
  post({ type: "progress", phase: "loading", fraction: 0, table: 0, detail: "loading plotter" });
  // Must match pointerFor(job.k > 26) below.
  const variant = job.k > 26 ? "64" : "32";
  const M = await loadModule(variant);
  current = M;

  M._pos2w_reset();
  // In hybrid mode this worker's own thread feeds the GPU while the plot threads work, so
  // leave it a core.
  M._pos2w_set_threads(job.gpu === "hybrid" ? Math.max(1, job.threads - 1) : job.threads);
  const gpu = await setUpGpu(M, job);
  try {
    await plotAndWrite(M, job, gpu, t0);
  } finally {
    gpu.stop();
  }
}

async function plotAndWrite(M: Pos2Module, job: PlotJob, gpu: GpuAttachment, t0: number) {
  // The heap grows on the plot thread, which leaves Emscripten's HEAPU8 view on this
  // thread pointing at the old, shorter buffer. Always build a fresh view.
  const heap = () => new Uint8Array(M.wasmMemory.buffer);
  const at = pointerFor(job.k > 26);
  const errorMessage = () => M.UTF8ToString(ptr(M._pos2w_error()));
  const alloc = (bytes: Uint8Array) => {
    const p = ptr(M._malloc(at(bytes.length)));
    heap().set(bytes, p);
    return p;
  };
  const pGroup = alloc(job.plotGroupId);
  const pMemo = alloc(job.memo);
  const rc = M._pos2w_start(at(pGroup), job.k, job.strength, job.plotIndex, job.metaGroup, at(pMemo), job.memo.length);
  M._free(at(pGroup));
  M._free(at(pMemo));
  if (rc !== 0) throw new Error(`plotter rejected parameters (code ${rc})`);
  M._pos2w_pause(paused ? 1 : 0);

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
  const gpuNote = gpuSummary(M, job, gpu);
  gpu.stop();
  const status = M._pos2w_status();
  if (status === Status.cancelled) {
    M._pos2w_reset();
    post({ type: "cancelled" });
    return;
  }
  if (status !== Status.plotted) {
    let message = errorMessage() || `plotter failed (status ${status})`;
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
    if (headerSize < 0) throw new Error(errorMessage() || "failed to prepare plot");
    const numChunks = M._pos2w_num_chunks();
    // Reserve the header. It is rewritten at the end, once it knows where the chunk index
    // starts.
    await writer.write(0, new Uint8Array(headerSize));
    let pos = headerSize;
    for (let i = 0; ; i++) {
      if (cancelRequested) throw new DOMException("cancelled", "AbortError");
      // The write loop runs here in JavaScript, so pausing it is just waiting.
      while (paused && !cancelRequested) await sleep(100);
      // Each chunk, then the chunk index.
      const p = ptr(M._pos2w_next_piece());
      if (!p) break;
      const len = M._pos2w_piece_len();
      // slice() copies out of the shared WASM heap, which file APIs do not accept.
      await writer.write(pos, heap().slice(p, p + len));
      pos += len;
      if (i % 16 === 0) {
        post({
          type: "progress", phase: "writing", fraction: Math.min(1, i / numChunks), table: 0,
          detail: `writing chunk ${Math.min(i + 1, numChunks)} of ${numChunks}`,
          heapBytes: M.wasmMemory.buffer.byteLength,
        });
      }
    }
    if (M._pos2w_status() < 0) throw new Error(errorMessage());
    const h = ptr(M._pos2w_header());
    if (!h) throw new Error(errorMessage() || "plot file is incomplete");
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
      post({ type: "error", message: errorText(e) });
    });
  }
};
