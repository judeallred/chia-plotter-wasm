/// <reference lib="webworker" />
// Checks plots with the pos2 prover, solver and validator compiled to WASM, running the
// same steps as `chia plots check`. Files are mounted with WORKERFS, which reads them
// lazily, so large plots are never copied into memory.

import { type GpuHost, type GpuWorkerState, attachGpu, ptr } from "./gpu";
import { readPlotHeader } from "./plot-header";
import type { FromValidator, ValidateRequest } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

interface Pos2v {
  wasmMemory: WebAssembly.Memory;
  FS: {
    mkdirTree(p: string): void;
    mount(type: unknown, opts: object, mountpoint: string): void;
    unmount(mountpoint: string): void;
  };
  WORKERFS: unknown;
  _malloc(n: number): number;
  _free(p: number): void;
  UTF8ToString(p: number): string;
  stringToUTF8(s: string, p: number, max: number): void;
  lengthBytesUTF8(s: string): number;
  _pos2v_start(path: number, plotGroupId: number, k: number, strength: number, metaGroup: number, challenge: number): number;
  _pos2v_status(): number;
  _pos2v_gpu_enable(on: number): void;
  _pos2v_found(): number;
  _pos2v_solved(): number;
  _pos2v_valid(): number;
  _pos2v_error(): number;
}

let modulePromise: Promise<Pos2v> | null = null;
function load(): Promise<Pos2v> {
  if (!modulePromise) {
    const url = new URL(`${import.meta.env.BASE_URL}wasm/pos2v.js`, self.location.origin).href;
    modulePromise = import(/* @vite-ignore */ url).then((m) =>
      m.default({ printErr: (s: string) => console.warn("[pos2v]", s), mainScriptUrlOrBlob: url }),
    ) as Promise<Pos2v>;
  }
  return modulePromise;
}

const post = (m: FromValidator) => self.postMessage(m);

// The challenges chia plots check uses: sha256 of the index as 32 big endian bytes.
async function challenge(i: number): Promise<Uint8Array> {
  const buf = new Uint8Array(32);
  new DataView(buf.buffer).setUint32(28, i);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

// The ID of the first plot in a group: sha256(group ID, plot index 0 as 2 big endian bytes,
// meta group), as posCalculatePlotIdForIndex in pos2-chip does.
async function firstPlotId(groupId: Uint8Array, metaGroup: number): Promise<Uint8Array> {
  const buf = new Uint8Array(35);
  buf.set(groupId);
  buf[34] = metaGroup;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

let mountCount = 0;
const gpuState: GpuWorkerState = {};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function validate(req: ValidateRequest) {
  const t0 = performance.now();
  const header = await readPlotHeader(req.file);
  post({ type: "header", id: req.id, header });
  const M = await load();
  const heap = () => new Uint8Array(M.wasmMemory.buffer);
  const mountpoint = `/v${mountCount++}`;
  M.FS.mkdirTree(mountpoint);
  M.FS.mount(M.WORKERFS, { files: [req.file] }, mountpoint);
  const pathStr = `${mountpoint}/${req.file.name}`;
  const pathLen = M.lengthBytesUTF8(pathStr) + 1;
  const pPath = ptr(M._malloc(pathLen));
  M.stringToUTF8(pathStr, pPath, pathLen);
  const pId = ptr(M._malloc(32));
  heap().set(header.plotGroupId, pId);
  const pCh = ptr(M._malloc(32));

  // The solver hashes every x for each proof, the main thing worth putting on the GPU. The
  // self test only checks the hash implementation, so the group's first plot ID will do.
  M._pos2v_gpu_enable(0);
  const gpu = req.gpu
    ? await attachGpu(gpuState, M as unknown as GpuHost, "pos2v", {
        plotId: await firstPlotId(header.plotGroupId, header.metaGroup), k: header.k, strength: 2, pairs: false,
        memory64: false,
      })
    : { note: "GPU off", stillEnabled: () => false, stop: () => {} };
  let gpuNote = gpu.note;

  const run = async (i: number) => {
    heap().set(await challenge(i), pCh);
    if (M._pos2v_start(pPath, pId, header.k, header.strength, header.metaGroup, pCh) !== 0) {
      throw new Error("validator rejected the header's parameters");
    }
    while (M._pos2v_status() === 1) await new Promise((r) => setTimeout(r, 5));
    if (M._pos2v_status() !== 2) throw new Error(M.UTF8ToString(M._pos2v_error()));
    return { found: M._pos2v_found(), solved: M._pos2v_solved(), valid: M._pos2v_valid() };
  };

  let found = 0, solved = 0, valid = 0;
  let error: string | undefined;
  try {
    for (let i = 0; i < req.challenges; i++) {
      const r = await run(i);
      found += r.found;
      solved += r.solved;
      valid += r.valid;
      post({ type: "progress", id: req.id, done: i + 1, total: req.challenges, found, valid });
    }
  } catch (e) {
    error = errorText(e);
  } finally {
    if (gpu.stats && !gpu.stillEnabled()) gpuNote = "GPU failed, finished on CPU";
    gpu.stop();
    [pPath, pId, pCh].forEach((p) => M._free(p));
    M.FS.unmount(mountpoint);
  }
  post({
    type: "result", id: req.id, challenges: req.challenges,
    found, solved, valid, ms: performance.now() - t0, gpuNote, error,
  });
}

// One file at a time. Requests queue up in order.
let queue = Promise.resolve();
self.onmessage = (ev: MessageEvent<ValidateRequest>) => {
  const req = ev.data;
  queue = queue.then(() =>
    validate(req).catch((e: unknown) => {
      post({
        type: "result", id: req.id, challenges: req.challenges,
        found: 0, solved: 0, valid: 0, ms: 0, gpuNote: "", error: errorText(e),
      });
    }),
  );
};
