// The service loop that answers GPU requests from the WASM plotter and solver (see
// core/src/gpu_bridge.hpp).

import { type GParams, type GpuG, type PairChunk, type PairsJob, copyChunk } from "./device";
import { type GpuHost, fn, ptr } from "./host";
import { PAIR_OUT_WORDS } from "./wgsl";

// Offsets into the shared Request struct. Mirrors pos2w::gpu::Request, whose static_assert
// lists the same offsets.
const R = {
  state: 0, op: 4, k: 8, key1: 16, key2: 32, bitmaskShift: 48,
  bitmaskWords: 52, outPtr: 56, outCapacity: 64, bitmaskPtr: 72, resultCount: 80, gpuMs: 88,
  tableId: 96, strength: 100, numMatchKeys: 104, mask: 108, inPtr: 112, count: 120,
  rPtr: 128, rCount: 136, auxPtr: 144, lStride: 152, direct: 156, feistelKeys: 160,
} as const;
const REQUEST_BYTES = 208;
// pos2w::gpu::State and Op.
const State = { idle: 0, requested: 1, done: 2, failed: 3 } as const;
const Op = { fillXs: 1, filterBitmask: 2, findPairs: 3, copyPairs: 4 } as const;

// Request fields, read through a fresh view each time: the heap can grow while a request runs.
class Request {
  constructor(
    private memory: WebAssembly.Memory,
    private base: number,
  ) {}

  private get view() {
    return new DataView(this.memory.buffer, this.base, REQUEST_BYTES);
  }

  u32(offset: number) {
    return this.view.getUint32(offset, true);
  }

  // A 64 bit field holding a pointer or a count, both well below 2^53.
  u64(offset: number) {
    return Number(this.view.getBigUint64(offset, true));
  }

  setU64(offset: number, value: number) {
    this.view.setBigUint64(offset, BigInt(value), true);
  }

  setF64(offset: number, value: number) {
    this.view.setFloat64(offset, value, true);
  }

  params(): GParams {
    const key1 = new Uint32Array(4);
    const key2 = new Uint32Array(4);
    for (let i = 0; i < 4; i++) {
      key1[i] = this.u32(R.key1 + 4 * i);
      key2[i] = this.u32(R.key2 + 4 * i);
    }
    return { key1, key2, k: this.u32(R.k) };
  }
}

// Waits until the state word may have changed. Atomics.waitAsync is missing in some
// browsers, which then poll.
async function waitForChange(state: Int32Array, seen: number) {
  if (typeof Atomics.waitAsync === "function") {
    const w = Atomics.waitAsync(state, 0, seen, 500);
    if (w.async) await w.value;
  } else {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export interface Service {
  stop(): void;
}

// Answers GPU requests from the module until stop() is called. Any error marks the request
// failed, which makes C++ fall back to its CPU code.
export function serve(gpu: GpuG, M: GpuHost, prefix: string, log: (msg: string) => void): Service {
  const base = ptr(fn(M, prefix, "gpu_request_ptr")());
  const req = new Request(M.wasmMemory, base);
  const heap = (at: number, bytes: number) => new Uint8Array(M.wasmMemory.buffer, at, bytes);
  const words = (at: number, count: number) => new Uint32Array(M.wasmMemory.buffer, at, count);
  let running = true;
  // Distinguishes this plot's buffers from earlier plots' at the same addresses.
  const serveId = crypto.randomUUID();
  // Results of the last findPairs request in hybrid mode, waiting for copyPairs.
  let held: PairChunk[] = [];
  let heldPairs = 0;
  const dropHeld = () => {
    for (const c of held) c.buffer.destroy();
    held = [];
    heldPairs = 0;
  };

  const fillXs = async (params: GParams) => {
    const out = req.u64(R.outPtr);
    await gpu.fillXs(params, 0, 2 ** params.k, (offset, data) => words(out + offset * 8, data.length).set(data));
  };

  const filterBitmask = async (params: GParams) => {
    const bitmask = words(req.u64(R.bitmaskPtr), req.u32(R.bitmaskWords)).slice();
    const { pairs, total } = await gpu.filterBitmask(params, bitmask, req.u32(R.bitmaskShift), req.u64(R.outCapacity));
    words(req.u64(R.outPtr), pairs.length).set(pairs);
    req.setU64(R.resultCount, total);
  };

  const findPairs = async (params: GParams) => {
    dropHeld();
    const tableId = req.u32(R.tableId);
    const stride = req.u32(R.lStride);
    const count = req.u64(R.count);
    const rCount = req.u64(R.rCount);
    const numMatchKeys = req.u32(R.numMatchKeys);
    const inPtr = req.u64(R.inPtr);
    const rPtr = req.u64(R.rPtr);
    const job: PairsJob = {
      tableId,
      strength: req.u32(R.strength),
      numMatchKeys,
      targetMask: req.u32(R.mask),
      stride,
      feistelKeys: Uint32Array.from({ length: 12 }, (_, i) => req.u32(R.feistelKeys + 4 * i)),
      left: words(inPtr, count * stride),
      right: words(rPtr, rCount * stride),
      leftKey: `${serveId}:${tableId}:${inPtr}:${count}`,
      rightKey: `${serveId}:${tableId}:${rPtr}:${rCount}`,
      prefix: words(req.u64(R.auxPtr), numMatchKeys + 1),
    };
    const pairBytes = PAIR_OUT_WORDS[tableId] * 4;
    if (req.u32(R.direct)) {
      // GPU mode: write each batch straight into the plotter's output array.
      const out = req.u64(R.outPtr);
      const capacity = req.u64(R.outCapacity) * pairBytes;
      let written = 0;
      await gpu.findPairs(params, job, (bytes) => {
        if (written + bytes.length > capacity) throw new Error("table pairs exceed the plotter's output array");
        heap(out + written, bytes.length).set(bytes);
        written += bytes.length;
      });
      req.setU64(R.resultCount, written / pairBytes);
    } else {
      // Hybrid mode: the CPU is appending to the output too, so C++ reserves room once both
      // are done and then asks for the pairs with copyPairs.
      held = await gpu.findPairs(params, job);
      heldPairs = held.reduce((n, c) => n + c.bytes, 0) / pairBytes;
      req.setU64(R.resultCount, heldPairs);
    }
  };

  const copyPairs = () => {
    const t = performance.now();
    if (req.u64(R.count) !== heldPairs) {
      dropHeld();
      throw new Error("copyPairs count does not match the pairs found");
    }
    const chunks = held;
    held = [];
    heldPairs = 0;
    let at = req.u64(R.outPtr);
    for (const c of chunks) {
      copyChunk(c, heap(at, c.bytes));
      at += c.bytes;
    }
    gpu.stats.copyMs += performance.now() - t;
  };

  const handle = async () => {
    if (gpu.lost) throw new Error("GPU device lost");
    const op = req.u32(R.op);
    const params = req.params();
    if (op === Op.fillXs) await fillXs(params);
    else if (op === Op.filterBitmask) await filterBitmask(params);
    else if (op === Op.findPairs) await findPairs(params);
    else if (op === Op.copyPairs) copyPairs();
    else throw new Error(`unknown GPU op ${op}`);
  };

  const loop = async () => {
    while (running) {
      const state = new Int32Array(M.wasmMemory.buffer, base, 1);
      const seen = Atomics.load(state, 0);
      if (seen !== State.requested) {
        await waitForChange(state, seen);
        continue;
      }
      const t0 = performance.now();
      let ok = true;
      try {
        await handle();
      } catch (e) {
        ok = false;
        log(`GPU request failed, falling back to CPU: ${e instanceof Error ? e.message : e}`);
      }
      req.setF64(R.gpuMs, performance.now() - t0);
      const s = new Int32Array(M.wasmMemory.buffer, base, 1);
      Atomics.store(s, 0, ok ? State.done : State.failed);
      Atomics.notify(s, 0);
    }
  };
  loop().catch((e: unknown) => {
    // Only reachable through a bug in the loop itself. Fail any waiting request so C++
    // falls back to the CPU instead of waiting forever.
    log(`GPU service stopped: ${e instanceof Error ? e.message : e}`);
    const s = new Int32Array(M.wasmMemory.buffer, base, 1);
    if (Atomics.load(s, 0) === State.requested) {
      Atomics.store(s, 0, State.failed);
      Atomics.notify(s, 0);
    }
  });
  return {
    stop: () => {
      running = false;
      dropHeld();
    },
  };
}
