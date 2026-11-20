// The WebGPU device and the host side of each kernel: buffers, dispatches and readback.

import { PAIRS_WGSL, PAIR_OUT_WORDS, WG, WGSL, tTables } from "./wgsl";

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

// Where table pair finding spent its time, for the plot's GPU note.
export interface PairStats {
  uploadMs: number;
  gpuMs: number;
  copyMs: number;
  requests: number;
}

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
}

// x values per fill_xs dispatch. 2^22 entries are 32 MB of output.
const FILL_BATCH = 1 << 22;
// x values per filter_bitmask dispatch. Nothing is written per x, so this can be larger.
const FILTER_BATCH = 1 << 24;
// Left candidate uploads and per batch candidate lists stay under this. Plotting k28
// already uses about 11 GB of WASM memory, and bigger GPU buffers push machines into swap.
const PIECE_BYTES = 256 * 2 ** 20;

async function compile(device: GPUDevice, code: string): Promise<GPUShaderModule> {
  const module = device.createShaderModule({ code });
  const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === "error");
  if (errors.length) throw new Error(`WGSL: ${errors.map((e) => e.message).join("; ")}`);
  return module;
}

const binding = (index: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
  binding: index,
  visibility: GPUShaderStage.COMPUTE,
  buffer: { type },
});

// Runs fn inside a validation error scope, so a WebGPU mistake becomes an exception.
async function validated<T>(device: GPUDevice, fn: () => Promise<T>): Promise<T> {
  device.pushErrorScope("validation");
  let result: T;
  try {
    result = await fn();
  } finally {
    const err = await device.popErrorScope();
    if (err) throw new Error(`WebGPU: ${err.message}`);
  }
  return result;
}

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
  // Reset by the caller per plot.
  stats: PairStats = { uploadMs: 0, gpuMs: 0, copyMs: 0, requests: 0 };

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
    // Binding types in order, matching the @binding declarations in wgsl.ts.
    const layoutOf = (types: GPUBufferBindingType[]) =>
      device.createPipelineLayout({
        bindGroupLayouts: [device.createBindGroupLayout({ entries: types.map((t, i) => binding(i, t)) })],
      });
    const module = await compile(device, WGSL);
    const layout = layoutOf(["uniform", "read-only-storage", "storage", "read-only-storage", "storage"]);
    const fillPipe = device.createComputePipeline({ layout, compute: { module, entryPoint: "fill_xs" } });
    const filterPipe = device.createComputePipeline({ layout, compute: { module, entryPoint: "filter_bitmask" } });
    const pairsModule = await compile(device, PAIRS_WGSL);
    const pairsLayout = layoutOf([
      "uniform", "read-only-storage", "storage", "read-only-storage", "storage",
      "read-only-storage", "read-only-storage", "storage", "storage",
    ]);
    const pairPipe = (entryPoint: string) =>
      device.createComputePipeline({ layout: pairsLayout, compute: { module: pairsModule, entryPoint } });
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

  // The g(x) kernels' uniform buffer.
  private params(p: GParams, xStart: number, count: number, shift = 0, capacity = 0): GPUBuffer {
    const u = new Uint32Array(16);
    u.set(p.key1, 0);
    u.set(p.key2, 4);
    const [gx] = this.dispatchSize(count);
    const kMask = p.k >= 32 ? 0xffffffff : (1 << p.k) - 1;
    u.set([xStart, count, kMask, shift, capacity, gx * WG, 0, 0], 8);
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
  // memory of its own, so a single 1 GB write at k28 needs another 1 GB. Views of the
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
    this.stats.requests++;
    const chunks: PairChunk[] = [];
    // Not trusted for reuse unless this call succeeds.
    const lastRight = this.lastRightKey;
    this.lastRightKey = undefined;
    try {
      await validated(this.device, () => this.findPairsIn(p, job, lastRight, chunks, sink));
    } catch (e) {
      for (const c of chunks) c.buffer.destroy();
      throw e;
    }
    this.lastRightKey = job.rightKey;
    return chunks;
  }

  private async findPairsIn(
    p: GParams, job: PairsJob, lastRight: string | undefined, chunks: PairChunk[], sink?: (pairs: Uint8Array) => void,
  ) {
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

    // The previous right side is this left side: keep it as the left buffer. Only for sides
    // that fit in one piece (k26 and below). Bigger ones go up in pieces instead, because
    // holding two whole sections on the GPU at k28 pushes most machines into swap.
    const previousRight = this.pairBufs.get("r");
    const reuseLeft =
      previousRight !== undefined && job.leftKey !== undefined && job.leftKey === lastRight && job.left.byteLength <= PIECE_BYTES;
    if (reuseLeft) {
      const l = this.pairBufs.get("l");
      this.pairBufs.set("l", previousRight);
      if (l) this.pairBufs.set("r", l);
      else this.pairBufs.delete("r");
    }
    const rBuf = this.pairBuf("r", job.right.byteLength, S | GPUBufferUsage.COPY_DST);
    const pBuf = this.pairBuf("prefix", job.prefix.byteLength, S | GPUBufferUsage.COPY_DST);
    const counter = this.pairBuf("counter", 16, S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const indirect = this.pairBuf("indirect", 16, S | GPUBufferUsage.INDIRECT);
    // Stands in for the indirect buffer in pair_test, which cannot bind it as storage while
    // reading its dispatch size from it.
    const spare = this.pairBuf("spare", 16, S);
    this.upload(rBuf, job.right);
    d.queue.writeBuffer(pBuf, 0, job.prefix);
    this.stats.uploadMs += performance.now() - t0;
    const dir = this.buildDir(p, job, targetBits, { r: rBuf, prefix: pBuf, counter, spare, indirect });

    const lChunk = Math.min(lCount, Math.floor(Math.min(limit, PIECE_BYTES) / (job.stride * 4)));
    for (let l0 = 0; l0 < lCount; l0 += lChunk) {
      const lc = Math.min(lChunk, lCount - l0);
      const t1 = performance.now();
      const lBuf = this.pairBuf("l", lc * job.stride * 4, S | GPUBufferUsage.COPY_DST);
      if (!(reuseLeft && lc === lCount)) this.upload(lBuf, job.left, l0 * job.stride, lc * job.stride);
      this.stats.uploadMs += performance.now() - t1;
      // Match keys per dispatch, bounded by threads and by the expected candidate list.
      let mk0 = 0;
      while (mk0 < job.numMatchKeys) {
        let mk1 = mk0;
        let expected = 0;
        while (mk1 < job.numMatchKeys) {
          const add = (lc * (job.prefix[mk1 + 1] - job.prefix[mk1])) / 2 ** targetBits;
          if (mk1 > mk0 && ((mk1 + 1 - mk0) * lc > 2 ** 30 || (expected + add) * 1.2 * 8 > PIECE_BYTES)) break;
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
            { out: outBuf, l: lBuf, counter, r: rBuf, aux: dir.buf, cand: candBuf, indirect, spare },
            { lCount: lc, mk0, mkCount: mk1 - mk0, extra, testMask, capacity, candCapacity, threads: lc * (mk1 - mk0), dir },
            capacity * outWords * 4, !sink);
          this.stats.gpuMs += performance.now() - t2;
          if (n <= capacity && candidates <= candCapacity) {
            if (sink) {
              const t3 = performance.now();
              try {
                sink(new Uint8Array(read.getMappedRange(256, n * outWords * 4)));
              } finally {
                read.unmap();
              }
              this.stats.copyMs += performance.now() - t3;
            } else {
              chunks.push({ buffer: read, bytes: n * outWords * 4 });
            }
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
  }

  // Builds the bucket directory over the right candidates (see build_dir in wgsl.ts). About
  // four candidates per bucket: a two step search, and a directory a quarter the size of
  // the candidate count (64 MB at k28).
  private buildDir(
    p: GParams, job: PairsJob, targetBits: number,
    b: Record<"r" | "prefix" | "counter" | "spare" | "indirect", GPUBuffer>,
  ) {
    const rCount = job.right.length / job.stride;
    const dirBits = Math.max(0, Math.min(targetBits, Math.floor(Math.log2(Math.max(1, rCount / job.numMatchKeys))) - 2));
    const dir = { shift: targetBits - dirBits, buckets: 2 ** dirBits };
    const buf = this.pairBuf("dir", job.numMatchKeys * (dir.buckets + 1) * 4, GPUBufferUsage.STORAGE);
    const threads = job.numMatchKeys * (dir.buckets + 1);
    const params = this.pairParams(p, job, {
      lCount: 0, mk0: 0, mkCount: job.numMatchKeys, extra: 0, testMask: 0, capacity: 0, candCapacity: 0, threads, dir,
    });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pairPipes.dir);
    // build_dir reads no left candidates, so the T-table stands in for them.
    pass.setBindGroup(0, this.pairBindGroup({
      params, out: buf, l: this.lut, counter: b.counter, r: b.r, aux: b.prefix, cand: b.spare, indirect: b.indirect,
    }));
    pass.dispatchWorkgroups(...this.dispatchSize(threads));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    params.destroy();
    return { ...dir, buf };
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
    const outBytes = Math.max(16, capacity * 8);
    if (outBytes > d.limits.maxStorageBufferBindingSize) throw new Error("filter output exceeds GPU buffer limit");
    const owned: GPUBuffer[] = [];
    const buffer = (size: number, usage: GPUBufferUsageFlags) => {
      const b = d.createBuffer({ size, usage });
      owned.push(b);
      return b;
    };
    try {
      return await validated(d, async () => {
        const maskBuf = buffer(Math.max(16, bitmask.byteLength), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
        d.queue.writeBuffer(maskBuf, 0, bitmask);
        const out = buffer(outBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        const counter = buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
        d.queue.writeBuffer(counter, 0, new Uint32Array(4));
        const enc = d.createCommandEncoder();
        for (let off = 0; off < numXs; off += FILTER_BATCH) {
          const n = Math.min(FILTER_BATCH, numXs - off);
          const params = this.params(p, off, n, shift, capacity);
          owned.push(params);
          const pass = enc.beginComputePass();
          pass.setPipeline(this.filterPipe);
          pass.setBindGroup(0, this.bindGroup(this.filterPipe, params, out, maskBuf, counter));
          pass.dispatchWorkgroups(...this.dispatchSize(n));
          pass.end();
        }
        const countRead = buffer(16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
        enc.copyBufferToBuffer(counter, 0, countRead, 0, 16);
        d.queue.submit([enc.finish()]);
        await countRead.mapAsync(GPUMapMode.READ);
        const total = new Uint32Array(countRead.getMappedRange())[0];
        countRead.unmap();
        const n = Math.min(total, capacity);
        let pairs = new Uint32Array(0);
        if (n > 0) {
          const read = buffer(n * 8, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
          const e2 = d.createCommandEncoder();
          e2.copyBufferToBuffer(out, 0, read, 0, n * 8);
          d.queue.submit([e2.finish()]);
          await read.mapAsync(GPUMapMode.READ);
          pairs = new Uint32Array(read.getMappedRange()).slice();
          read.unmap();
        }
        return { pairs, total };
      });
    } finally {
      for (const b of owned) b.destroy();
    }
  }
}
