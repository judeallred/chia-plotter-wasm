// WebGPU kernels for the pos2 hashes, and the service loop that answers requests from the
// WASM plotter and solver (see core/src/gpu_bridge.hpp).
//
// Every pos2 hash is some number of iterations of two AES encryption rounds (AESENC, no
// key schedule) keyed by the plot ID. g(x) runs 16 on the state {x, 0, 0, 0}. The kernels
// use a T-table kept in workgroup memory (see AES_WGSL).

// Offsets into the shared Request struct. Mirrors pos2w::gpu::Request.
const R = {
  state: 0, op: 4, k: 8, xorConst: 12, key1: 16, key2: 32, bitmaskShift: 48,
  bitmaskWords: 52, outPtr: 56, outCapacity: 64, bitmaskPtr: 72, resultCount: 80, gpuMs: 88,
  tableId: 96, strength: 100, numMatchKeys: 104, mask: 108, inPtr: 112, count: 120,
  rPtr: 128, rCount: 136, auxPtr: 144, lStride: 152, direct: 156, feistelKeys: 160,
} as const;
const REQUEST_BYTES = 208;
const State = { idle: 0, requested: 1, done: 2, failed: 3 } as const;
const Op = { fillXs: 1, filterBitmask: 2, findPairs: 3, copyPairs: 4 } as const;

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

// Threads per workgroup. Small workgroups measured fastest for the T-table AES on Apple
// GPUs (32: 786 M g(x)/s against 631 M at 256).
const WG = 32;

// One AESENC round (ShiftRows, SubBytes, MixColumns, then XOR the key) with a single 1 KB
// T-table in workgroup memory. The other three T-tables are byte rotations of the first,
// and a rotate is cheaper than the extra workgroup memory.
const AES_WGSL = /* wgsl */ `
var<workgroup> T: array<u32, 256>;

fn load_tables(li: u32) {
  for (var i = li; i < 256u; i += ${WG}u) {
    T[i] = lut[i];
  }
  workgroupBarrier();
}

fn r8(x: u32) -> u32 { return (x << 8u) | (x >> 24u); }
fn r16(x: u32) -> u32 { return (x << 16u) | (x >> 16u); }
fn r24(x: u32) -> u32 { return (x << 24u) | (x >> 8u); }

fn enc(w: vec4<u32>, key: vec4<u32>) -> vec4<u32> {
  let n0 = T[w.x & 0xffu] ^ r8(T[(w.y >> 8u) & 0xffu]) ^ r16(T[(w.z >> 16u) & 0xffu]) ^ r24(T[w.w >> 24u]);
  let n1 = T[w.y & 0xffu] ^ r8(T[(w.z >> 8u) & 0xffu]) ^ r16(T[(w.w >> 16u) & 0xffu]) ^ r24(T[w.x >> 24u]);
  let n2 = T[w.z & 0xffu] ^ r8(T[(w.w >> 8u) & 0xffu]) ^ r16(T[(w.x >> 16u) & 0xffu]) ^ r24(T[w.y >> 24u]);
  let n3 = T[w.w & 0xffu] ^ r8(T[(w.x >> 8u) & 0xffu]) ^ r16(T[(w.y >> 16u) & 0xffu]) ^ r24(T[w.z >> 24u]);
  return vec4<u32>(n0, n1, n2, n3) ^ key;
}
`;

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

${AES_WGSL}
fn g(x: u32) -> u32 {
  var w = vec4<u32>(x ^ P.xor_const, 0u, 0u, 0u);
  for (var r = 0u; r < 16u; r++) {
    w = enc(w, P.key1);
    w = enc(w, P.key2);
  }
  return w.x & P.mask;
}

// Writes {g(x), x} for x in [x_start, x_start + count).
@compute @workgroup_size(${WG})
fn fill_xs(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  load_tables(li);
  let idx = gid.x + gid.y * P.row;
  if (idx >= P.count) { return; }
  let x = P.x_start + idx;
  out_buf[2u * idx] = g(x);
  out_buf[2u * idx + 1u] = x;
}

// Appends {x, g(x)} for every x whose bit (g(x) >> shift) is set in bitmask.
@compute @workgroup_size(${WG})
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

// Pair finding for table construction, one thread per (left candidate, match key). Mirrors
// TableConstructorGeneric: hash the left candidate's matching target, find the right
// candidates with that target by binary search (the right side is sorted by match_info
// within each match key), and run the pairing test on each. Passing pairs are appended in
// the output struct of the table (T1Pairing, T2Pairing or a proof fragment).
const PAIRS_WGSL = /* wgsl */ `
struct Params {
  key1: vec4<u32>,
  key2: vec4<u32>,
  fk: array<vec4<u32>, 3>,
  k: u32,
  table_id: u32,
  l_count: u32,
  mk0: u32,
  mk_count: u32,
  target_mask: u32,
  mt_rounds: u32,
  pair_rounds: u32,
  test_mask: u32,
  capacity: u32,
  row: u32,
  cand_capacity: u32,
  stride: u32,
  dir_shift: u32, // match target >> dir_shift is the directory bucket
  dir_buckets: u32, // buckets per match key
  pad: u32,
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> lut: array<u32, 1024>;
@group(0) @binding(2) var<storage, read_write> out_buf: array<u32>;
@group(0) @binding(3) var<storage, read> L: array<u32>;
// [0] passing pairs, [1] candidates.
@group(0) @binding(4) var<storage, read_write> counter: array<atomic<u32>, 4>;
@group(0) @binding(5) var<storage, read> R: array<u32>;
// find_candidates: the bucket directory. build_dir: the match key offsets.
@group(0) @binding(6) var<storage, read> prefix: array<u32>;
// Candidate (left, right) index pairs from find_candidates.
@group(0) @binding(7) var<storage, read_write> cand: array<u32>;
// Workgroup counts for the indirect pair_test dispatch, written by prep_pairs.
@group(0) @binding(8) var<storage, read_write> indirect: array<u32, 4>;

${AES_WGSL}
fn hash(start: vec4<u32>, rounds: u32) -> vec4<u32> {
  var w = start;
  for (var r = 0u; r < rounds; r++) {
    w = enc(w, P.key1);
    w = enc(w, P.key2);
  }
  return w;
}

// Candidate fields. Table 1 reads Xs_Candidate {match_info, x}, table 2 T1Pairing
// {meta lo, meta hi, match_info}, table 3 T2Pairing {meta lo, meta hi, match_info, x_bits}.
fn r_target(i: u32) -> u32 {
  if (P.table_id == 1u) { return R[2u * i] & P.target_mask; }
  return R[i * P.stride + 2u] & P.target_mask;
}
fn r_meta(i: u32) -> vec2<u32> {
  if (P.table_id == 1u) { return vec2<u32>(R[2u * i + 1u], 0u); }
  return vec2<u32>(R[i * P.stride], R[i * P.stride + 1u]);
}
fn l_meta(i: u32) -> vec2<u32> {
  if (P.table_id == 1u) { return vec2<u32>(L[2u * i + 1u], 0u); }
  return vec2<u32>(L[i * P.stride], L[i * P.stride + 1u]);
}

// meta >> s for a 64 bit meta held as (lo, hi), 0 < s < 64.
fn shr64(m: vec2<u32>, s: u32) -> u32 {
  if (s >= 32u) { return m.y >> (s - 32u); }
  return (m.x >> s) | (m.y << (32u - s));
}

fn kmask() -> u32 { return (1u << P.k) - 1u; }

fn rotl(v: u32, s: u32) -> u32 { return ((v << s) & kmask()) | (v >> (P.k - s)); }

fn fkey(i: u32) -> u32 { return P.fk[i >> 2u][i & 3u]; }

// FeistelCipher::encrypt with 4 rounds on the 2k bit value (left, right).
fn feistel(left0: u32, right0: u32) -> vec2<u32> {
  let m = kmask();
  var left = left0;
  var right = right0;
  for (var r = 0u; r < 4u; r++) {
    var a = right;
    var b = fkey(3u * r);
    var c = fkey(3u * r + 1u);
    var d = fkey(3u * r + 2u);
    a = (a + b) & m;
    d = rotl(d ^ a, 16u);
    c = (c + d) & m;
    b = rotl(b ^ c, 12u);
    a = (a + b) & m;
    d = rotl(d ^ a, 8u);
    c = (c + d) & m;
    b = rotl(b ^ c, 7u);
    let next_right = (left ^ b) & m;
    left = right;
    right = next_right;
  }
  return vec2<u32>(left, right);
}

// Bucket directory over the right candidates: for each match key, dir_buckets + 1 offsets,
// where entry b is the first candidate whose target is at least b << dir_shift, and the
// last entry is the end of the match key. Replaces a long binary search per thread with a
// lookup and a short scan. Written to out_buf, with prefix holding the match key offsets.
@compute @workgroup_size(${WG})
fn build_dir(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x + gid.y * P.row;
  let per = P.dir_buckets + 1u;
  if (idx >= P.mk_count * per) { return; }
  let mk = idx / per;
  let b = idx - mk * per;
  let end = prefix[mk + 1u];
  if (b == P.dir_buckets) {
    out_buf[idx] = end;
    return;
  }
  let v = b << P.dir_shift;
  var lo = prefix[mk];
  var hi = end;
  while (lo < hi) {
    let mid = (lo + hi) >> 1u;
    if (r_target(mid) < v) { lo = mid + 1u; } else { hi = mid; }
  }
  out_buf[idx] = lo;
}

// Pass 1, one thread per (left candidate, match key): hash the matching target and list
// every right candidate with that target. Each thread finds a varying number (about one on
// average), so the pairing hash runs in a separate pass where every thread does exactly
// one. Done here, each SIMD group would wait for its unluckiest lane.
@compute @workgroup_size(${WG})
fn find_candidates(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  load_tables(li);
  let idx = gid.x + gid.y * P.row;
  if (idx >= P.l_count * P.mk_count) { return; }
  let mk_rel = idx / P.l_count;
  let l = idx - mk_rel * P.l_count;
  let mk = P.mk0 + mk_rel;
  let ml = l_meta(l);
  let tgt = hash(vec4<u32>(P.table_id, mk, ml.x, ml.y), P.mt_rounds).x & P.target_mask;

  let base = mk * (P.dir_buckets + 1u);
  let bucket = tgt >> P.dir_shift;
  let end = prefix[base + P.dir_buckets];
  var lo = prefix[base + bucket];
  var hi = prefix[base + bucket + 1u];
  while (lo < hi) {
    let mid = (lo + hi) >> 1u;
    if (r_target(mid) < tgt) { lo = mid + 1u; } else { hi = mid; }
  }
  for (var i = lo; i < end; i++) {
    if (r_target(i) != tgt) { break; }
    let slot = atomicAdd(&counter[1], 1u);
    if (slot < P.cand_capacity) {
      cand[2u * slot] = l;
      cand[2u * slot + 1u] = i;
    }
  }
}

// Sizes the pair_test dispatch from the candidate count.
@compute @workgroup_size(1)
fn prep_pairs() {
  let n = min(atomicLoad(&counter[1]), P.cand_capacity);
  let groups = (n + ${WG}u - 1u) / ${WG}u;
  let gx = min(groups, 65535u);
  indirect[0] = gx;
  indirect[1] = select(1u, (groups + gx - 1u) / gx, gx > 0u);
  indirect[2] = 1u;
}

// Pass 2, one thread per candidate: the pairing hash and test, then the table's output.
@compute @workgroup_size(${WG})
fn pair_test(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32,
    @builtin(num_workgroups) nwg: vec3<u32>) {
  load_tables(li);
  let idx = gid.x + gid.y * nwg.x * ${WG}u;
  if (idx >= min(atomicLoad(&counter[1]), P.cand_capacity)) { return; }
  let l = cand[2u * idx];
  let i = cand[2u * idx + 1u];
  let ml = l_meta(l);
  let mr = r_meta(i);
  let res = hash(vec4<u32>(ml.x, ml.y, mr.x, mr.y), P.pair_rounds);
  if ((res.w & P.test_mask) != 0u) { return; }
  let slot = atomicAdd(&counter[0], 1u);
  if (slot >= P.capacity) { return; }
  let half_k = P.k / 2u;
  if (P.table_id == 1u) {
    // T1Pairing: meta = x_l << k | x_r, match_info = k bits.
    out_buf[3u * slot] = (ml.x << P.k) | mr.x;
    out_buf[3u * slot + 1u] = ml.x >> (32u - P.k);
    out_buf[3u * slot + 2u] = res.x & kmask();
  } else if (P.table_id == 2u) {
    // T2Pairing: 2k bit meta, k bit match_info, and the top k/2 bits of each side's x1.
    let xl = shr64(ml, P.k + half_k);
    let xr = shr64(mr, P.k + half_k);
    out_buf[4u * slot] = res.y;
    out_buf[4u * slot + 1u] = res.z & ((1u << (2u * P.k - 32u)) - 1u);
    out_buf[4u * slot + 2u] = res.x & kmask();
    out_buf[4u * slot + 3u] = (xl << half_k) | xr;
  } else {
    // Proof fragment: Feistel encryption of x_bits_l << k | x_bits_r.
    let f = feistel(L[l * P.stride + 3u], R[i * P.stride + 3u]);
    out_buf[2u * slot] = (f.x << P.k) | f.y;
    out_buf[2u * slot + 1u] = f.x >> (32u - P.k);
  }
}
`;

// Output words per pair for tables 1 to 3: T1Pairing, T2Pairing, proof fragment.
const PAIR_OUT_WORDS = [0, 3, 4, 2];

// Pairs found by findPairs, in a mapped read buffer: a 256 byte header, then bytes of pairs.
export interface PairChunk {
  buffer: GPUBuffer;
  bytes: number;
}

// Copies a chunk's pairs into dst and frees the chunk.
export function copyChunk(c: PairChunk, dst: Uint8Array) {
  dst.set(new Uint8Array(c.buffer.getMappedRange(256, c.bytes)));
  c.buffer.unmap();
  c.buffer.destroy();
}

export function readChunk(c: PairChunk): Uint32Array {
  const out = new Uint8Array(c.bytes);
  copyChunk(c, out);
  return new Uint32Array(out.buffer);
}

// Time spent in findPairs since the last reset, for the plot's GPU note.
export const pairStats = { uploadMs: 0, gpuMs: 0, copyMs: 0, requests: 0 };

export interface PairsJob {
  tableId: number;
  strength: number;
  numMatchKeys: number;
  targetMask: number;
  stride: number; // words per candidate
  feistelKeys: Uint32Array; // 12 words, table 3 only
  left: Uint32Array; // raw left candidates
  right: Uint32Array; // raw right candidates
  // Where left and right came from, so data already on the GPU is not uploaded again.
  // Sections pair up as (3,0), (0,2), (2,1), (1,3): each right side is the next left side.
  leftKey?: string;
  rightKey?: string;
  prefix: Uint32Array; // numMatchKeys + 1 offsets into right
}

export interface GParams {
  key1: Uint32Array; // 4 words
  key2: Uint32Array; // 4 words
  k: number;
  xorConst: number;
}

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
    private pairPipes: Record<"dir" | "cand" | "prep" | "test", GPUComputePipeline>,
    private lut: GPUBuffer,
  ) {}

  // Buffers reused across findPairs calls, grown as needed.
  private pairBufs = new Map<string, GPUBuffer>();
  private lastRightKey: string | undefined;

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
    const pairsModule = device.createShaderModule({ code: PAIRS_WGSL });
    const pairsInfo = await pairsModule.getCompilationInfo();
    const pairsErrors = pairsInfo.messages.filter((m) => m.type === "error");
    if (pairsErrors.length) throw new Error(`WGSL: ${pairsErrors.map((e) => e.message).join("; ")}`);
    const storage = (type: GPUBufferBindingType) => ({ visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    const pairsLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, ...storage("uniform") },
        { binding: 1, ...storage("read-only-storage") },
        { binding: 2, ...storage("storage") },
        { binding: 3, ...storage("read-only-storage") },
        { binding: 4, ...storage("storage") },
        { binding: 5, ...storage("read-only-storage") },
        { binding: 6, ...storage("read-only-storage") },
        { binding: 7, ...storage("storage") },
        { binding: 8, ...storage("storage") },
      ],
    });
    const pairsPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [pairsLayout] });
    const pairPipe = (entryPoint: string) =>
      device.createComputePipeline({ layout: pairsPipelineLayout, compute: { module: pairsModule, entryPoint } });
    const pairPipes = { dir: pairPipe("build_dir"), cand: pairPipe("find_candidates"), prep: pairPipe("prep_pairs"), test: pairPipe("pair_test") };
    const lut = device.createBuffer({ size: 4096, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(lut, 0, tTables());
    const i = adapter.info;
    const g = new GpuG(device, [i.vendor, i.architecture, i.device].filter(Boolean).join(" "), fillPipe, filterPipe, pairPipes, lut);
    device.lost.then(() => {
      g.lost = true;
    });
    return g;
  }

  private params(p: GParams, xStart: number, count: number, shift = 0, capacity = 0, mask?: number, pad = 0): GPUBuffer {
    const u = new Uint32Array(16);
    u.set(p.key1, 0);
    u.set(p.key2, 4);
    const groups = Math.ceil(count / WG);
    const gx = Math.min(groups, 65535);
    const kMask = p.k >= 32 ? 0xffffffff : (1 << p.k) - 1;
    u.set([xStart, count, p.xorConst, mask ?? kMask, shift, capacity, gx * WG, pad], 8);
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

  // A reusable buffer of at least size bytes, grown when too small.
  private pairBuf(name: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
    const have = this.pairBufs.get(name);
    if (have && have.size >= size) return have;
    have?.destroy();
    const buf = this.device.createBuffer({ size: Math.max(256, Math.ceil(size / 256) * 256), usage });
    this.pairBufs.set(name, buf);
    return buf;
  }

  // Uploads part of a typed array, in 64 MB pieces: the browser stages each writeBuffer in
  // memory of its own, and a single 1 GB write at k28 costs that much again. Views of the
  // shared WASM heap go straight to writeBuffer where the browser allows it (WebGPU takes
  // shared buffers, older builds may not), else each piece is copied first.
  private upload(buf: GPUBuffer, data: Uint32Array, offsetWords = 0, words = data.length) {
    const piece = 16 * 2 ** 20;
    for (let done = 0; done < words; done += piece) {
      const n = Math.min(piece, words - done);
      try {
        this.device.queue.writeBuffer(buf, done * 4, data, offsetWords + done, n);
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        this.device.queue.writeBuffer(buf, done * 4, data.slice(offsetWords + done, offsetWords + done + n));
      }
    }
  }

  // Finds a section's table pairs, in no particular order. With a sink, hands each batch's
  // output structs to it as they arrive (the view is only valid during the call). Without
  // one, returns them in mapped GPU buffers, each to be released with readChunk or copyChunk.
  async findPairs(p: GParams, job: PairsJob, sink?: (pairs: Uint8Array) => void): Promise<PairChunk[]> {
    const d = this.device;
    const S = GPUBufferUsage.STORAGE;
    // Buffers up to 2 GB, which fits a k28 section of the largest candidate type.
    const limit = Math.floor(Math.min(d.limits.maxStorageBufferBindingSize, d.limits.maxBufferSize, 2 ** 31) / 256) * 256;
    const outWords = PAIR_OUT_WORDS[job.tableId];
    const lCount = job.left.length / job.stride;
    const rCount = job.right.length / job.stride;
    if (rCount * job.stride * 4 > limit) throw new Error("right candidates exceed the GPU buffer limit");
    const extra = job.tableId === 1 ? job.strength - 2 : 0;
    const testMask = job.tableId === 1 ? 3 : 2 ** job.strength - 1;
    const targetBits = Math.log2(job.targetMask + 1);
    const t0 = performance.now();

    // The previous right side is this left side: keep it as the left buffer. Only for sides up
    // to 256 MB (k26 and below). Bigger ones go up in pieces instead, because holding two
    // whole sections on the GPU at k28 pushes most machines into swap.
    const pieceBytes = 256 * 2 ** 20;
    const reuseLeft = job.leftKey !== undefined && job.leftKey === this.lastRightKey && job.left.byteLength <= pieceBytes;
    if (reuseLeft) {
      const r = this.pairBufs.get("r")!;
      const l = this.pairBufs.get("l");
      this.pairBufs.set("l", r);
      if (l) this.pairBufs.set("r", l);
      else this.pairBufs.delete("r");
    }
    this.lastRightKey = undefined;
    const rBuf = this.pairBuf("r", job.right.byteLength, S | GPUBufferUsage.COPY_DST);
    const pBuf = this.pairBuf("prefix", job.prefix.byteLength, S | GPUBufferUsage.COPY_DST);
    const counter = this.pairBuf("counter", 16, S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const indirect = this.pairBuf("indirect", 16, S | GPUBufferUsage.INDIRECT);
    // Stands in for the indirect buffer in pair_test, which cannot bind it as storage while
    // reading its dispatch size from it.
    const spare = this.pairBuf("spare", 16, S);
    this.upload(rBuf, job.right);
    d.queue.writeBuffer(pBuf, 0, job.prefix);
    pairStats.uploadMs += performance.now() - t0;
    // About four right candidates per directory bucket: a 2 step search, and a directory a
    // quarter the size of the candidates' count (64 MB at k28).
    const dirBits = Math.max(0, Math.min(targetBits, Math.floor(Math.log2(Math.max(1, rCount / job.numMatchKeys))) - 2));
    const dir = { shift: targetBits - dirBits, buckets: 2 ** dirBits };
    const dirBuf = this.pairBuf("dir", job.numMatchKeys * (dir.buckets + 1) * 4, S);
    {
      const enc = d.createCommandEncoder();
      const pass = enc.beginComputePass();
      const threads = job.numMatchKeys * (dir.buckets + 1);
      const params = this.pairParams(p, job, { lCount: 0, mk0: 0, mkCount: job.numMatchKeys, extra: 0, testMask: 0, capacity: 0, candCapacity: 0, threads, dir });
      const bufs = { params, out: dirBuf, l: this.lut, counter, r: rBuf, aux: pBuf, cand: spare, indirect };
      pass.setPipeline(this.pairPipes.dir);
      pass.setBindGroup(0, this.pairBindGroup(bufs));
      pass.dispatchWorkgroups(...this.dispatchSize(threads));
      pass.end();
      d.queue.submit([enc.finish()]);
      params.destroy();
    }

    // Candidate lists per batch stay under this, which bounds the GPU memory a section needs
    // on top of its inputs. Plotting k28 already uses about 11 GB of WASM memory.
    const batchBytes = Math.min(limit / 2, 256 * 2 ** 20);
    const chunks: PairChunk[] = [];
    d.pushErrorScope("validation");
    try {
      const lChunk = Math.min(lCount, Math.floor(Math.min(limit, pieceBytes) / (job.stride * 4)));
      for (let l0 = 0; l0 < lCount; l0 += lChunk) {
        const lc = Math.min(lChunk, lCount - l0);
        const t1 = performance.now();
        const lBuf = this.pairBuf("l", lc * job.stride * 4, S | GPUBufferUsage.COPY_DST);
        if (!(reuseLeft && lc === lCount)) this.upload(lBuf, job.left, l0 * job.stride, lc * job.stride);
        pairStats.uploadMs += performance.now() - t1;
        // Match keys per dispatch, bounded by threads and by the expected candidate list.
        let mk0 = 0;
        while (mk0 < job.numMatchKeys) {
          let mk1 = mk0;
          let expected = 0;
          while (mk1 < job.numMatchKeys) {
            const add = (lc * (job.prefix[mk1 + 1] - job.prefix[mk1])) / 2 ** targetBits;
            if (mk1 > mk0 && ((mk1 + 1 - mk0) * lc > 2 ** 30 || (expected + add) * 1.2 * 8 > batchBytes)) break;
            expected += add;
            mk1++;
          }
          let candCapacity = Math.min(Math.ceil(expected * 1.2) + 4096, Math.floor(limit / 8));
          // Output per batch is far smaller than the candidate list (1 in 4 or fewer pass).
          let capacity = Math.min(Math.ceil((expected / (testMask + 1)) * 1.25) + 4096, Math.floor(limit / (outWords * 4)));
          for (let attempt = 0; ; attempt++) {
            const outBuf = this.pairBuf("out", capacity * outWords * 4, S | GPUBufferUsage.COPY_SRC);
            const candBuf = this.pairBuf("cand", candCapacity * 8, S);
            const t2 = performance.now();
            const { n, candidates, read } = await this.pairsBatch(p, job,
              { out: outBuf, l: lBuf, counter, r: rBuf, aux: dirBuf, cand: candBuf, indirect, spare },
              { lCount: lc, mk0, mkCount: mk1 - mk0, extra, testMask, capacity, candCapacity, threads: lc * (mk1 - mk0), dir },
              capacity * outWords * 4, !sink);
            pairStats.gpuMs += performance.now() - t2;
            const fits = n <= capacity && candidates <= candCapacity;
            if (fits && !sink) {
              chunks.push({ buffer: read, bytes: n * outWords * 4 });
              break;
            }
            if (fits && sink) {
              const t3 = performance.now();
              try {
                sink(new Uint8Array(read.getMappedRange(256, n * outWords * 4)));
              } finally {
                read.unmap();
              }
              pairStats.copyMs += performance.now() - t3;
              break;
            }
            // More than expected. Run again with room for all of them.
            read.unmap();
            if (!sink) read.destroy();
            if (attempt >= 2 || candidates * 8 > limit) throw new Error("table pairs exceed the GPU buffer limit");
            candCapacity = Math.max(candCapacity, candidates);
            capacity = Math.min(Math.max(capacity, n, Math.ceil((candidates / (testMask + 1)) * 1.5) + 4096), Math.floor(limit / (outWords * 4)));
          }
          mk0 = mk1;
        }
      }
    } catch (e) {
      for (const c of chunks) c.buffer.destroy();
      throw e;
    } finally {
      // Not trusted for reuse after an error.
      this.lastRightKey = undefined;
      const err = await d.popErrorScope();
      if (err) {
        for (const c of chunks) c.buffer.destroy();
        throw new Error(`WebGPU: ${err.message}`);
      }
    }
    this.lastRightKey = job.rightKey;
    return chunks;
  }

  // The pair kernels' uniform buffer.
  private pairParams(
    p: GParams, job: PairsJob,
    q: {
      lCount: number; mk0: number; mkCount: number; extra: number; testMask: number; capacity: number; candCapacity: number;
      threads: number; dir: { shift: number; buckets: number };
    },
  ): GPUBuffer {
    const [gx] = this.dispatchSize(q.threads);
    const u = new Uint32Array(36);
    u.set(p.key1, 0);
    u.set(p.key2, 4);
    u.set(job.feistelKeys, 8);
    u.set([
      p.k, job.tableId, q.lCount, q.mk0, q.mkCount, job.targetMask >>> 0, 16 << q.extra, 16 << q.extra,
      q.testMask >>> 0, q.capacity, gx * WG, q.candCapacity, job.stride, q.dir.shift, q.dir.buckets, 0,
    ], 20);
    const buf = this.device.createBuffer({ size: u.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, u);
    return buf;
  }

  private pairBindGroup(b: Record<"params" | "out" | "l" | "counter" | "r" | "aux" | "cand" | "indirect", GPUBuffer>) {
    return this.device.createBindGroup({
      layout: this.pairPipes.cand.getBindGroupLayout(0),
      entries: [b.params, this.lut, b.out, b.l, b.counter, b.r, b.aux, b.cand, b.indirect].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  // One batch: find candidates, size the pair pass, run it, and read back. Returns the
  // pair and candidate counts, which can exceed their capacities, and a mapped buffer with
  // the counts in the first 256 bytes and the pairs after them.
  private async pairsBatch(
    p: GParams, job: PairsJob,
    b: Record<"out" | "l" | "counter" | "r" | "aux" | "cand" | "indirect" | "spare", GPUBuffer>,
    q: Parameters<GpuG["pairParams"]>[2],
    outBytes: number,
    freshRead: boolean,
  ): Promise<{ n: number; candidates: number; read: GPUBuffer }> {
    const d = this.device;
    d.queue.writeBuffer(b.counter, 0, new Uint32Array(4));
    const params = this.pairParams(p, job, q);
    const bufs = { ...b, params };
    // Copying the whole capacity is cheap next to a second round trip for the count.
    // Held results need a buffer each. Results handed to a sink are copied out at once, so
    // one buffer is reused.
    const readUsage = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
    const read = freshRead ? d.createBuffer({ size: 256 + outBytes, usage: readUsage }) : this.pairBuf("read", 256 + outBytes, readUsage);
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pairPipes.cand);
    pass.setBindGroup(0, this.pairBindGroup(bufs));
    pass.dispatchWorkgroups(...this.dispatchSize(q.threads));
    pass.setPipeline(this.pairPipes.prep);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.pairPipes.test);
    pass.setBindGroup(0, this.pairBindGroup({ ...bufs, indirect: b.spare }));
    pass.dispatchWorkgroupsIndirect(b.indirect, 0);
    pass.end();
    enc.copyBufferToBuffer(b.counter, 0, read, 0, 16);
    enc.copyBufferToBuffer(b.out, 0, read, 256, outBytes);
    d.queue.submit([enc.finish()]);
    params.destroy();
    await read.mapAsync(GPUMapMode.READ);
    const counts = new Uint32Array(read.getMappedRange(0, 16));
    return { n: counts[0], candidates: counts[1], read };
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
// values, including the top of the range, and with pairs set, pair finding for each table.
// Returns false on any difference. Set big for memory64 builds, whose exports take pointers
// as BigInt.
export async function selfTest(
  gpu: GpuG, M: GpuHost, prefix: string, big: boolean, plotId: Uint8Array, k: number, testnet: boolean, strength = 2,
  pairs = false,
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
    // Pair finding for each table, against the CPU's matching target and pairing test.
    if (ok && pairs) ok = await selfTestPairs(gpu, M, prefix, toPtr, p, params, strength);
  } finally {
    (M._free as (p: number) => void)(p);
  }
  return ok;
}

// Builds small left and right candidate sets for each table where most left candidates have
// a partner under one of two match keys, runs them through findPairs, and compares the
// output with the CPU's matching target and pairing test.
async function selfTestPairs(
  gpu: GpuG, M: GpuHost, prefix: string, toPtr: (n: number) => unknown, plotIdPtr: number, params: GParams, strength: number,
): Promise<boolean> {
  const k = params.k;
  const cpuMt = fn(M, prefix, "gpu_cpu_match_target");
  const mtBits = fn(M, prefix, "gpu_match_target_bits");
  const cpuPair = fn(M, prefix, "gpu_cpu_pair");
  const malloc = M._malloc as (n: unknown) => unknown;
  const free = M._free as (p: unknown) => void;
  const scratch = ptr(malloc(toPtr(48 + 64)));
  const words = () => new Uint32Array(M.wasmMemory.buffer, scratch, 28);
  fn(M, prefix, "gpu_feistel_keys")(toPtr(plotIdPtr), k, toPtr(scratch + 64));
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
      const bits = mtBits(k, strength, table) as number;
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
        return (cpuMt(toPtr(plotIdPtr), k, strength, table, mk, lo, hi) as number) >>> 0;
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
      await gpu.findPairs(params, job, (bytes) => collect(new Uint32Array(bytes.slice().buffer)));

      const want: string[] = [];
      for (const c of left) {
        for (let mk = 0; mk < 2; mk++) {
          const t = targetOf(c, mk);
          for (const r of groups[mk]) {
            if ((r[miOffset] & targetMask) !== t) continue;
            const w = words();
            w.set(c, 0);
            w.set(r, 4);
            if (cpuPair(toPtr(plotIdPtr), k, strength, table, toPtr(scratch), toPtr(scratch + 16), toPtr(scratch + 32))) {
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
    free(toPtr(scratch));
  }
}

// Answers GPU requests from the module until stop() is called. Any error marks the request
// failed, which makes C++ fall back to its CPU code.
export function serve(gpu: GpuG, M: GpuHost, prefix: string, log: (msg: string) => void) {
  const base = ptr(fn(M, prefix, "gpu_request_ptr")());
  let running = true;
  // Distinguishes this plot's buffers from earlier plots' at the same addresses.
  const serveId = crypto.randomUUID();
  // Results of the last findPairs request, waiting for copyPairs.
  let held: PairChunk[] = [];
  const dropHeld = () => {
    for (const c of held) c.buffer.destroy();
    held = [];
  };
  const loop = async () => {
    while (running) {
      const state = new Int32Array(M.wasmMemory.buffer, base, 1);
      if (Atomics.load(state, 0) !== State.requested) {
        const w = Atomics.waitAsync(state, 0, Atomics.load(state, 0), 500);
        if (w.async) await w.value;
        continue;
      }
      const view = new DataView(M.wasmMemory.buffer, base, REQUEST_BYTES);
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
          const fresh = new DataView(M.wasmMemory.buffer, base, REQUEST_BYTES);
          new Uint32Array(M.wasmMemory.buffer, outPtr, pairs.length).set(pairs);
          fresh.setBigUint64(R.resultCount, BigInt(total), true);
        } else if (op === Op.findPairs) {
          dropHeld();
          pairStats.requests++;
          const stride = view.getUint32(R.lStride, true);
          const count = Number(view.getBigUint64(R.count, true));
          const rCount = Number(view.getBigUint64(R.rCount, true));
          const numMatchKeys = view.getUint32(R.numMatchKeys, true);
          const words = (p: number, n: number) => new Uint32Array(M.wasmMemory.buffer, p, n);
          const feistelKeys = new Uint32Array(12);
          for (let i = 0; i < 12; i++) feistelKeys[i] = view.getUint32(R.feistelKeys + 4 * i, true);
          const job: PairsJob = {
            tableId: view.getUint32(R.tableId, true),
            strength: view.getUint32(R.strength, true),
            numMatchKeys,
            targetMask: view.getUint32(R.mask, true),
            stride,
            feistelKeys,
            left: words(Number(view.getBigUint64(R.inPtr, true)), count * stride),
            right: words(Number(view.getBigUint64(R.rPtr, true)), rCount * stride),
            leftKey: `${serveId}:${view.getUint32(R.tableId, true)}:${view.getBigUint64(R.inPtr, true)}:${count}`,
            rightKey: `${serveId}:${view.getUint32(R.tableId, true)}:${view.getBigUint64(R.rPtr, true)}:${rCount}`,
            prefix: words(Number(view.getBigUint64(R.auxPtr, true)), numMatchKeys + 1),
          };
          let total = 0;
          if (view.getUint32(R.direct, true)) {
            // Write each batch straight into the plotter's output array.
            const capacity = Number(view.getBigUint64(R.outCapacity, true)) * PAIR_OUT_WORDS[job.tableId] * 4;
            let written = 0;
            await gpu.findPairs(params, job, (bytes) => {
              if (written + bytes.length > capacity) throw new Error("table pairs exceed the plotter's output array");
              new Uint8Array(M.wasmMemory.buffer, outPtr + written, bytes.length).set(bytes);
              written += bytes.length;
            });
            total = written / 4 / PAIR_OUT_WORDS[job.tableId];
          } else {
            held = await gpu.findPairs(params, job);
            total = held.reduce((n, c) => n + c.bytes / 4 / PAIR_OUT_WORDS[job.tableId], 0);
          }
          new DataView(M.wasmMemory.buffer, base, REQUEST_BYTES).setBigUint64(R.resultCount, BigInt(total), true);
        } else if (op === Op.copyPairs) {
          const t = performance.now();
          let at = outPtr;
          for (const c of held) {
            copyChunk(c, new Uint8Array(M.wasmMemory.buffer, at, c.bytes));
            at += c.bytes;
          }
          held = [];
          pairStats.copyMs += performance.now() - t;
        } else {
          throw new Error(`unknown GPU op ${op}`);
        }
      } catch (e) {
        ok = false;
        log(`GPU request failed, falling back to CPU: ${e instanceof Error ? e.message : e}`);
      }
      const fresh = new DataView(M.wasmMemory.buffer, base, REQUEST_BYTES);
      fresh.setFloat64(R.gpuMs, performance.now() - t0, true);
      const s = new Int32Array(M.wasmMemory.buffer, base, 1);
      Atomics.store(s, 0, ok ? State.done : State.failed);
      Atomics.notify(s, 0);
    }
  };
  void loop();
  return { stop: () => (running = false) };
}
