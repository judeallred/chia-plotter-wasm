// WGSL kernels for the pos2 hashes, and the T-table they share.
//
// Every pos2 hash is some number of iterations of two AES encryption rounds (AESENC, no
// key schedule) keyed by the plot ID. g(x) runs 16 on the state {x, 0, 0, 0}. The kernels
// use a T-table kept in workgroup memory (see AES_WGSL).

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
export function tTables(): Uint32Array {
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
export const WG = 32;

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

export const WGSL = /* wgsl */ `
struct Params {
  key1: vec4<u32>,
  key2: vec4<u32>,
  x_start: u32,
  count: u32,
  mask: u32,
  shift: u32,
  capacity: u32,
  row: u32,
  pad0: u32,
  pad1: u32,
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> lut: array<u32, 1024>;
@group(0) @binding(2) var<storage, read_write> out_buf: array<u32>;
@group(0) @binding(3) var<storage, read> bitmask: array<u32>;
@group(0) @binding(4) var<storage, read_write> counter: array<atomic<u32>, 1>;

${AES_WGSL}
fn g(x: u32) -> u32 {
  var w = vec4<u32>(x, 0u, 0u, 0u);
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
export const PAIRS_WGSL = /* wgsl */ `
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
export const PAIR_OUT_WORDS = [0, 3, 4, 2];
