// Checks the GPU kernels against the CPU implementation in the WASM module before a plot or
// a validation trusts them.

import { type GParams, type GpuG, readChunk } from "./device";
import { type GpuHost, type HostFn, type Pointer, fn, pointerFor, ptr } from "./host";
import { PAIR_OUT_WORDS } from "./wgsl";

export interface SelfTestParams {
  plotId: Uint8Array;
  k: number;
  testnet: boolean;
  strength: number;
  // Also check table pair finding (the plotter's kernels).
  pairs: boolean;
  // The module is a memory64 build, whose exports take pointers as BigInt.
  memory64: boolean;
}

// Numbers returned by the module's CPU reference functions (uint32_t results).
const u32 = (v: Pointer) => Number(v) >>> 0;

// Checks GPU g(x) against the CPU implementation in the WASM module for a few thousand x
// values, including the top of the range, and with pairs set, pair finding for each table.
// Returns false on any difference.
export async function selfTest(gpu: GpuG, M: GpuHost, prefix: string, t: SelfTestParams): Promise<boolean> {
  const { plotId, k, testnet, strength } = t;
  const at = pointerFor(t.memory64);
  const malloc = M._malloc as HostFn;
  const free = M._free as HostFn;
  const p = ptr(malloc(at(32)));
  new Uint8Array(M.wasmMemory.buffer).set(plotId, p);
  const words = new Uint32Array(plotId.slice(0, 32).buffer);
  const params: GParams = {
    key1: words.slice(0, 4), key2: words.slice(4, 8), k, xorConst: testnet ? 0xa3b1c4d7 : 0,
  };
  const cpuG = fn(M, prefix, "gpu_cpu_g");
  const numXs = 2 ** k;
  let ok = true;
  try {
    for (const start of [0, Math.floor(numXs / 3), numXs - 2048]) {
      await gpu.fillXs(params, start, 2048, (_off, data) => {
        for (let i = 0; i < 2048 && ok; i += 3) {
          const cpu = u32(cpuG(at(p), k, testnet ? 1 : 0, start + i));
          if (data[2 * i] !== cpu || data[2 * i + 1] !== start + i) ok = false;
        }
      });
    }
    // Pair finding for each table, against the CPU's matching target and pairing test.
    if (ok && t.pairs) ok = await selfTestPairs(gpu, M, prefix, at, p, params, strength);
  } finally {
    free(at(p));
  }
  return ok;
}

// Builds small left and right candidate sets for each table where most left candidates have
// a partner under one of two match keys, runs them through findPairs, and compares the
// output with the CPU's matching target and pairing test.
async function selfTestPairs(
  gpu: GpuG, M: GpuHost, prefix: string, at: (n: number) => Pointer, plotIdPtr: number, params: GParams, strength: number,
): Promise<boolean> {
  const k = params.k;
  const cpuMt = fn(M, prefix, "gpu_cpu_match_target");
  const mtBits = fn(M, prefix, "gpu_match_target_bits");
  const cpuPair = fn(M, prefix, "gpu_cpu_pair");
  const malloc = M._malloc as HostFn;
  const free = M._free as HostFn;
  const scratch = ptr(malloc(at(48 + 64)));
  const words = () => new Uint32Array(M.wasmMemory.buffer, scratch, 28);
  fn(M, prefix, "gpu_feistel_keys")(at(plotIdPtr), k, at(scratch + 64));
  const feistelKeys = words().slice(16, 28);
  const rand = () => crypto.getRandomValues(new Uint32Array(1))[0];
  const kMask = (2 ** k - 1) >>> 0;
  const metaHiMask = (2 ** (2 * k - 32) - 1) >>> 0;
  // Enough candidates for a few dozen passing pairs at the strength's pass rate.
  const n = Math.min(16384, Math.max(1024, 64 * 2 ** strength));
  try {
    for (let table = 1; table <= 3; table++) {
      const stride = table === 1 ? 2 : table === 2 ? 3 : 4;
      const outWords = PAIR_OUT_WORDS[table];
      const numMatchKeys = table === 1 ? 4 : 2 ** strength;
      const bits = Number(mtBits(k, strength, table));
      const targetMask = bits >= 32 ? 0xffffffff : (2 ** bits - 1) >>> 0;
      const miOffset = table === 1 ? 0 : 2;
      // A random candidate with the given match_info.
      const candidate = (matchInfo: number) => {
        const c = new Uint32Array(stride);
        if (table === 1) c.set([matchInfo, rand() & kMask]);
        else c.set([rand(), rand() & metaHiMask, matchInfo, rand() & kMask].slice(0, stride));
        return c;
      };
      const meta = (c: Uint32Array) => (table === 1 ? [c[1], 0] : [c[0], c[1]]);
      const left = Array.from({ length: n }, () => candidate(rand() & kMask));
      const targetOf = (c: Uint32Array, mk: number) => {
        const [lo, hi] = meta(c);
        return u32(cpuMt(at(plotIdPtr), k, strength, table, mk, lo, hi));
      };
      // Right candidates under match keys 0 and 1, sorted by match target within each.
      const groups: Uint32Array[][] = [[], []];
      left.forEach((c, i) => {
        const mk = i % 2;
        const copies = i % 7 === 0 ? 2 : 1;
        for (let j = 0; j < copies; j++) groups[mk].push(candidate((targetOf(c, mk) | (rand() & ~targetMask & kMask)) >>> 0));
      });
      for (const g of groups) g.sort((a, b) => (a[miOffset] & targetMask) - (b[miOffset] & targetMask));
      const right = [...groups[0], ...groups[1]];
      const pre = new Uint32Array(numMatchKeys + 1);
      for (let mk = 0; mk < numMatchKeys; mk++) pre[mk + 1] = pre[mk] + (mk < 2 ? groups[mk].length : 0);
      const flat = (list: Uint32Array[]) => {
        const out = new Uint32Array(list.length * stride);
        list.forEach((c, i) => out.set(c, i * stride));
        return out;
      };
      const got: string[] = [];
      const collect = (ch: Uint32Array) => {
        for (let i = 0; i < ch.length; i += outWords) got.push(Array.from(ch.subarray(i, i + outWords)).join(","));
      };
      const job = { tableId: table, strength, numMatchKeys, targetMask, stride, feistelKeys, left: flat(left), right: flat(right), prefix: pre };
      // Both ways of returning pairs: held in GPU buffers (hybrid) and through a sink (GPU).
      for (const c of await gpu.findPairs(params, job)) collect(readChunk(c));
      await gpu.findPairs(params, job, bytes => collect(new Uint32Array(bytes.slice().buffer)));

      const want: string[] = [];
      for (const c of left) {
        for (let mk = 0; mk < 2; mk++) {
          const t = targetOf(c, mk);
          for (const r of groups[mk]) {
            if ((r[miOffset] & targetMask) !== t) continue;
            const w = words();
            w.set(c, 0);
            w.set(r, 4);
            if (Number(cpuPair(at(plotIdPtr), k, strength, table, at(scratch), at(scratch + 16), at(scratch + 32)))) {
              want.push(Array.from(words().subarray(8, 8 + outWords)).join(","));
            }
          }
        }
      }
      // Each pair was collected twice, once per way.
      want.push(...want);
      got.sort();
      want.sort();
      if (want.length === 0 || got.join(";") !== want.join(";")) {
        console.warn(`GPU pair self test failed for table ${table}: ${got.length} GPU pairs, ${want.length} CPU pairs`);
        return false;
      }
    }
    return true;
  } finally {
    free(at(scratch));
  }
}

