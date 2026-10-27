// WebGPU implementation of the pos2 g(x) hash, and the service loop that answers requests
// from the WASM plotter and solver (see core/src/gpu_bridge.hpp).
//
// g(x) is 16 iterations of two AES encryption rounds (AESENC, no key schedule) keyed by
// the plot ID, applied to the 128 bit state {x, 0, 0, 0}, then masked to k bits. The kernels
// use the usual four 1 KB T-tables, kept in workgroup memory.

// Offsets into the shared Request struct. Mirrors pos2w::gpu::Request.
const R = {
  state: 0, op: 4, k: 8, xorConst: 12, key1: 16, key2: 32, bitmaskShift: 48,
  bitmaskWords: 52, outPtr: 56, outCapacity: 64, bitmaskPtr: 72, resultCount: 80, gpuMs: 88,
} as const;
const State = { idle: 0, requested: 1, done: 2, failed: 3 } as const;
const Op = { fillXs: 1, filterBitmask: 2 } as const;

const SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

// T-tables T0..T3 as one 1024 entry array. T0[a] = (2s, s, s, 3s) little endian for
// s = SBOX[a], and Tn is T0 rotated left by 8n bits. These match lutEnc0..3 in soft_aes.hpp.
function tTables(): Uint32Array {
  const t = new Uint32Array(1024);
  for (let a = 0; a < 256; a++) {
    const s = SBOX[a];
    const s2 = ((s << 1) ^ (s & 0x80 ? 0x1b : 0)) & 0xff;
    const t0 = (s2 | (s << 8) | (s << 16) | ((s2 ^ s) << 24)) >>> 0;
    for (let n = 0; n < 4; n++) t[n * 256 + a] = ((t0 << (8 * n)) | (t0 >>> (32 - 8 * n))) >>> 0;
  }
  return t;
}

const WGSL = /* wgsl */ `
struct Params {
  key1: vec4<u32>,
  key2: vec4<u32>,
  x_start: u32,
  count: u32,
  xor_const: u32,
  mask: u32,
  shift: u32,
  capacity: u32,
  row: u32,
  pad: u32,
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> lut: array<u32, 1024>;
@group(0) @binding(2) var<storage, read_write> out_buf: array<u32>;
@group(0) @binding(3) var<storage, read> bitmask: array<u32>;
@group(0) @binding(4) var<storage, read_write> counter: array<atomic<u32>, 1>;

var<workgroup> T: array<u32, 1024>;

// One AESENC round: ShiftRows, SubBytes, MixColumns via T-tables, then XOR the key.
fn enc(w: vec4<u32>, key: vec4<u32>) -> vec4<u32> {
  let n0 = T[w.x & 0xffu] ^ T[256u + ((w.y >> 8u) & 0xffu)] ^ T[512u + ((w.z >> 16u) & 0xffu)] ^ T[768u + (w.w >> 24u)];
  let n1 = T[w.y & 0xffu] ^ T[256u + ((w.z >> 8u) & 0xffu)] ^ T[512u + ((w.w >> 16u) & 0xffu)] ^ T[768u + (w.x >> 24u)];
  let n2 = T[w.z & 0xffu] ^ T[256u + ((w.w >> 8u) & 0xffu)] ^ T[512u + ((w.x >> 16u) & 0xffu)] ^ T[768u + (w.y >> 24u)];
  let n3 = T[w.w & 0xffu] ^ T[256u + ((w.x >> 8u) & 0xffu)] ^ T[512u + ((w.y >> 16u) & 0xffu)] ^ T[768u + (w.z >> 24u)];
  return vec4<u32>(n0, n1, n2, n3) ^ key;
}

fn g(x: u32) -> u32 {
  var w = vec4<u32>(x ^ P.xor_const, 0u, 0u, 0u);
  for (var r = 0u; r < 16u; r++) {
    w = enc(w, P.key1);
    w = enc(w, P.key2);
  }
  return w.x & P.mask;
}

fn load_tables(li: u32) {
  for (var i = li; i < 1024u; i += 256u) {
    T[i] = lut[i];
  }
  workgroupBarrier();
}

// Writes {g(x), x} for x in [x_start, x_start + count).
@compute @workgroup_size(256)
fn fill_xs(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  load_tables(li);
  let idx = gid.x + gid.y * P.row;
  if (idx >= P.count) { return; }
  let x = P.x_start + idx;
  out_buf[2u * idx] = g(x);
  out_buf[2u * idx + 1u] = x;
}

// Appends {x, g(x)} for every x whose bit (g(x) >> shift) is set in bitmask.
@compute @workgroup_size(256)
fn filter_bitmask(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  load_tables(li);
  let idx = gid.x + gid.y * P.row;
  if (idx >= P.count) { return; }
  let x = P.x_start + idx;
  let h = g(x);
  let b = h >> P.shift;
  if ((bitmask[b >> 5u] & (1u << (b & 31u))) != 0u) {
    let slot = atomicAdd(&counter[0], 1u);
    if (slot < P.capacity) {
      out_buf[2u * slot] = x;
      out_buf[2u * slot + 1u] = h;
    }
  }
}
`;

export interface GParams {
  key1: Uint32Array; // 4 words
  key2: Uint32Array; // 4 words
  k: number;
  xorConst: number;
}

const WG = 256;
// x values per fill_xs dispatch. 2^22 entries are 32 MB of output.
const FILL_BATCH = 1 << 22;
// x values per filter_bitmask dispatch. Nothing is written per x, so this can be larger.
const FILTER_BATCH = 1 << 24;

export class GpuG {
  private constructor(
    readonly device: GPUDevice,
    readonly adapterInfo: string,
    private fillPipe: GPUComputePipeline,
    private filterPipe: GPUComputePipeline,
    private lut: GPUBuffer,
  ) {}

  lost = false;

  static async create(): Promise<GpuG | null> {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    const module = device.createShaderModule({ code: WGSL });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length) throw new Error(`WGSL: ${errors.map((e) => e.message).join("; ")}`);
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const fillPipe = device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint: "fill_xs" } });
    const filterPipe = device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint: "filter_bitmask" } });
    const lut = device.createBuffer({ size: 4096, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(lut, 0, tTables());
    const i = adapter.info;
    const g = new GpuG(device, [i.vendor, i.architecture, i.device].filter(Boolean).join(" "), fillPipe, filterPipe, lut);
    device.lost.then(() => {
      g.lost = true;
    });
    return g;
  }

  private params(p: GParams, xStart: number, count: number, shift = 0, capacity = 0): GPUBuffer {
    const u = new Uint32Array(16);
    u.set(p.key1, 0);
    u.set(p.key2, 4);
    const groups = Math.ceil(count / WG);
    const gx = Math.min(groups, 65535);
    u.set([xStart, count, p.xorConst, p.k >= 32 ? 0xffffffff : (1 << p.k) - 1, shift, capacity, gx * WG, 0], 8);
    const buf = this.device.createBuffer({ size: u.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, u);
    return buf;
  }

  private dispatchSize(count: number): [number, number] {
    const groups = Math.ceil(count / WG);
    const gx = Math.min(groups, 65535);
    return [gx, Math.ceil(groups / gx)];
  }

  private bindGroup(pipe: GPUComputePipeline, params: GPUBuffer, out: GPUBuffer, bitmask: GPUBuffer, counter: GPUBuffer) {
    return this.device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: { buffer: this.lut } },
        { binding: 2, resource: { buffer: out } },
        { binding: 3, resource: { buffer: bitmask } },
        { binding: 4, resource: { buffer: counter } },
      ],
    });
  }

  // Computes {g(x), x} for x in [xStart, xStart + count) and hands each finished batch to
  // sink, in order. Keeps two batches in flight so copying overlaps GPU work.
  async fillXs(p: GParams, xStart: number, count: number, sink: (offset: number, data: Uint32Array) => void) {
    const d = this.device;
    // Unused bindings still need buffers. They must be distinct: WebGPU rejects one buffer
    // bound as both read-only and writable storage in the same dispatch.
    const dummyMask = d.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE });
    const dummyCounter = d.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE });
    d.pushErrorScope("validation");
    const slots = [0, 1].map(() => ({
      out: d.createBuffer({ size: FILL_BATCH * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
      read: d.createBuffer({ size: FILL_BATCH * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      pending: null as null | { offset: number; n: number; done: Promise<void> },
    }));
    const drain = async (slot: (typeof slots)[number]) => {
      if (!slot.pending) return;
      await slot.pending.done;
      sink(slot.pending.offset, new Uint32Array(slot.read.getMappedRange(0, slot.pending.n * 8)));
      slot.read.unmap();
      slot.pending = null;
    };
    try {
      let i = 0;
      for (let off = 0; off < count; off += FILL_BATCH, i++) {
        const n = Math.min(FILL_BATCH, count - off);
        const slot = slots[i % 2];
        await drain(slot);
        const params = this.params(p, xStart + off, n);
        const enc = d.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(this.fillPipe);
        pass.setBindGroup(0, this.bindGroup(this.fillPipe, params, slot.out, dummyMask, dummyCounter));
        pass.dispatchWorkgroups(...this.dispatchSize(n));
        pass.end();
        enc.copyBufferToBuffer(slot.out, 0, slot.read, 0, n * 8);
        d.queue.submit([enc.finish()]);
        slot.pending = { offset: off, n, done: slot.read.mapAsync(GPUMapMode.READ, 0, n * 8) };
        params.destroy();
      }
      for (const slot of slots) await drain(slot);
    } finally {
      const err = await d.popErrorScope();
      for (const s of slots) {
        s.out.destroy();
        s.read.destroy();
      }
      dummyMask.destroy();
      dummyCounter.destroy();
      if (err) throw new Error(`WebGPU: ${err.message}`);
    }
  }

  // Returns {x, g(x)} pairs whose bitmask bit is set, and the total number of matches,
  // which can exceed capacity.
  async filterBitmask(p: GParams, bitmask: Uint32Array, shift: number, capacity: number) {
    const d = this.device;
    const numXs = 2 ** p.k;
    const maskBuf = d.createBuffer({ size: Math.max(16, bitmask.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(maskBuf, 0, bitmask);
    const outBytes = Math.max(16, capacity * 8);
    if (outBytes > d.limits.maxStorageBufferBindingSize) throw new Error("filter output exceeds GPU buffer limit");
    const out = d.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const counter = d.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(counter, 0, new Uint32Array(4));
    d.pushErrorScope("validation");
    const enc = d.createCommandEncoder();
    const params: GPUBuffer[] = [];
    for (let off = 0; off < numXs; off += FILTER_BATCH) {
      const n = Math.min(FILTER_BATCH, numXs - off);
      const pb = this.params(p, off, n, shift, capacity);
      params.push(pb);
      const pass = enc.beginComputePass();
      pass.setPipeline(this.filterPipe);
      pass.setBindGroup(0, this.bindGroup(this.filterPipe, pb, out, maskBuf, counter));
      pass.dispatchWorkgroups(...this.dispatchSize(n));
      pass.end();
    }
    const countRead = d.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    enc.copyBufferToBuffer(counter, 0, countRead, 0, 16);
    d.queue.submit([enc.finish()]);
    await countRead.mapAsync(GPUMapMode.READ);
    const total = new Uint32Array(countRead.getMappedRange())[0];
    countRead.unmap();
    const n = Math.min(total, capacity);
    let pairs = new Uint32Array(0);
    if (n > 0) {
      const read = d.createBuffer({ size: n * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const e2 = d.createCommandEncoder();
      e2.copyBufferToBuffer(out, 0, read, 0, n * 8);
      d.queue.submit([e2.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      pairs = new Uint32Array(read.getMappedRange()).slice();
      read.unmap();
      read.destroy();
    }
    [maskBuf, out, counter, countRead, ...params].forEach((b) => b.destroy());
    const err = await d.popErrorScope();
    if (err) throw new Error(`WebGPU: ${err.message}`);
    return { pairs, total };
  }
}

// The parts of an Emscripten module the service needs. prefix is "pos2w" or "pos2v".
export interface GpuHost {
  wasmMemory: WebAssembly.Memory;
  [fn: string]: unknown;
}

const fn = (M: GpuHost, prefix: string, name: string) => M[`_${prefix}_${name}`] as (...a: unknown[]) => unknown;
const ptr = (v: unknown) => (typeof v === "bigint" ? Number(v) : (v as number) >>> 0);

function readParams(view: DataView): GParams {
  const key1 = new Uint32Array(4), key2 = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    key1[i] = view.getUint32(R.key1 + 4 * i, true);
    key2[i] = view.getUint32(R.key2 + 4 * i, true);
  }
  return { key1, key2, k: view.getUint32(R.k, true), xorConst: view.getUint32(R.xorConst, true) };
}

// Checks GPU g(x) against the CPU implementation in the WASM module for a few thousand x
// values, including the top of the range. Returns false on any difference. Set big for
// memory64 builds, whose exports take pointers as BigInt.
export async function selfTest(
  gpu: GpuG, M: GpuHost, prefix: string, big: boolean, plotId: Uint8Array, k: number, testnet: boolean,
): Promise<boolean> {
  const toPtr = (n: number) => (big ? BigInt(n) : n);
  const p = ptr((M._malloc as (n: number) => unknown)(32));
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
          const cpu = (cpuG(toPtr(p), k, testnet ? 1 : 0, start + i) as number) >>> 0;
          if (data[2 * i] !== cpu || data[2 * i + 1] !== start + i) ok = false;
        }
      });
    }
  } finally {
    (M._free as (p: number) => void)(p);
  }
  return ok;
}

// Answers GPU requests from the module until stop() is called. Any error marks the request
// failed, which makes C++ fall back to its CPU code.
export function serve(gpu: GpuG, M: GpuHost, prefix: string, log: (msg: string) => void) {
  const base = ptr(fn(M, prefix, "gpu_request_ptr")());
  let running = true;
  const loop = async () => {
    while (running) {
      const state = new Int32Array(M.wasmMemory.buffer, base, 1);
      if (Atomics.load(state, 0) !== State.requested) {
        const w = Atomics.waitAsync(state, 0, Atomics.load(state, 0), 500);
        if (w.async) await w.value;
        continue;
      }
      const view = new DataView(M.wasmMemory.buffer, base, 96);
      const t0 = performance.now();
      let ok = true;
      try {
        if (gpu.lost) throw new Error("GPU device lost");
        const op = view.getInt32(R.op, true);
        const params = readParams(view);
        const outPtr = Number(view.getBigUint64(R.outPtr, true));
        if (op === Op.fillXs) {
          await gpu.fillXs(params, 0, 2 ** params.k, (offset, data) => {
            new Uint32Array(M.wasmMemory.buffer, outPtr + offset * 8, data.length).set(data);
          });
        } else if (op === Op.filterBitmask) {
          const words = view.getUint32(R.bitmaskWords, true);
          const maskPtr = Number(view.getBigUint64(R.bitmaskPtr, true));
          const capacity = Number(view.getBigUint64(R.outCapacity, true));
          const bitmask = new Uint32Array(M.wasmMemory.buffer, maskPtr, words).slice();
          const { pairs, total } = await gpu.filterBitmask(params, bitmask, view.getUint32(R.bitmaskShift, true), capacity);
          const fresh = new DataView(M.wasmMemory.buffer, base, 96);
          new Uint32Array(M.wasmMemory.buffer, outPtr, pairs.length).set(pairs);
          fresh.setBigUint64(R.resultCount, BigInt(total), true);
        } else {
          throw new Error(`unknown GPU op ${op}`);
        }
      } catch (e) {
        ok = false;
        log(`GPU request failed, falling back to CPU: ${e instanceof Error ? e.message : e}`);
      }
      const fresh = new DataView(M.wasmMemory.buffer, base, 96);
      fresh.setFloat64(R.gpuMs, performance.now() - t0, true);
      const s = new Int32Array(M.wasmMemory.buffer, base, 1);
      Atomics.store(s, 0, ok ? State.done : State.failed);
      Atomics.notify(s, 0);
    }
  };
  void loop();
  return { stop: () => (running = false) };
}
