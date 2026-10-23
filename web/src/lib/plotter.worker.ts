/// <reference lib="webworker" />
// Runs the pos2 WASM plotter and streams the finished plot file to disk.
//
// The core module is loaded on demand. k28 needs the memory64 build (about 9 GB of heap),
// smaller k sizes use the wasm32 build. Plotting itself runs on a pthread inside the
// module, so this worker stays responsive and polls for progress.

import type { FromWorker, PlotJob, ToWorker } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

interface Pos2Module {
  HEAPU8: Uint8Array;
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
  _pos2w_begin_write(): number;
  _pos2w_next_chunk(): number | bigint;
  _pos2w_chunk_len(): number;
  _pos2w_num_chunks(): number;
  _pos2w_header(): number | bigint;
  _pos2w_header_len(): number;
  _pos2w_reset(): void;
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
  const t0 = performance.now();
  post({ type: "progress", phase: "loading", fraction: 0, table: 0, detail: "loading plotter" });
  const variant = job.k > 26 ? "64" : "32";
  const M = await loadModule(variant);
  current = M;
  const big = variant === "64";
  const toPtr = (n: number) => (big ? BigInt(n) : n);
  const fromPtr = (p: number | bigint) => Number(p);

  M._pos2w_reset();
  M._pos2w_set_threads(job.threads);

  const alloc = (bytes: Uint8Array) => {
    const p = fromPtr(M._malloc(toPtr(bytes.length)));
    M.HEAPU8.set(bytes, p);
    return p;
  };
  const pId = alloc(job.plotId);
  const pMemo = alloc(job.memo);
  const rc = M._pos2w_start(
    toPtr(pId), job.k, job.strength, 0, 0, toPtr(pMemo), job.memo.length, job.testnet ? 1 : 0,
  );
  M._free(toPtr(pId));
  M._free(toPtr(pMemo));
  if (rc !== 0) throw new Error(`plotter rejected parameters (code ${rc})`);

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
    });
  }
  const status = M._pos2w_status();
  if (status === Status.cancelled) {
    M._pos2w_reset();
    post({ type: "cancelled" });
    return;
  }
  if (status !== Status.plotted) {
    const message = M.UTF8ToString(M._pos2w_error()) || `plotter failed (status ${status})`;
    M._pos2w_reset();
    throw new Error(message);
  }
  const t1 = performance.now();

  const writer = await openWriter(job);
  let file: File | undefined;
  let bytes = 0;
  try {
    const headerSize = M._pos2w_begin_write();
    if (headerSize < 0) throw new Error(M.UTF8ToString(M._pos2w_error()) || "failed to prepare plot");
    const numChunks = M._pos2w_num_chunks();
    // Reserve the header. It is rewritten with the real chunk offsets at the end.
    await writer.write(0, new Uint8Array(headerSize));
    let pos = headerSize;
    for (let i = 0; ; i++) {
      if (cancelRequested) throw new DOMException("cancelled", "AbortError");
      const p = fromPtr(M._pos2w_next_chunk());
      if (!p) break;
      const len = M._pos2w_chunk_len();
      // slice() copies out of the shared WASM heap, which file APIs do not accept.
      await writer.write(pos, M.HEAPU8.slice(p, p + len));
      pos += len;
      if (i % 16 === 0) {
        post({
          type: "progress", phase: "writing", fraction: i / numChunks, table: 0,
          detail: `writing chunk ${i + 1} of ${numChunks}`,
        });
      }
    }
    if (M._pos2w_status() < 0) throw new Error(M.UTF8ToString(M._pos2w_error()));
    const h = fromPtr(M._pos2w_header());
    await writer.write(0, M.HEAPU8.slice(h, h + M._pos2w_header_len()));
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
  M._pos2w_reset();
  post({
    type: "done",
    filename: job.filename,
    bytes,
    file,
    timings: { totalMs: t2 - t0, plotMs: t1 - t0, writeMs: t2 - t1, tablesMs },
  });
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === "cancel") {
    cancelRequested = true;
    current?._pos2w_cancel();
    return;
  }
  if (msg.type === "plot") {
    runPlot(msg.job).catch((e: unknown) => {
      post({ type: "error", message: e instanceof Error ? e.message : String(e) });
    });
  }
};
