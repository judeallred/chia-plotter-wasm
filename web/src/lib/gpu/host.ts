// The parts of an Emscripten module the GPU code calls into. prefix is "pos2w" (plotter)
// or "pos2v" (validator).

export interface GpuHost {
  wasmMemory: WebAssembly.Memory;
  [fn: string]: unknown;
}

// Our exports take and return pointers as BigInt in memory64 builds (pos2w64) and as
// Numbers in wasm32 builds. Emscripten only converts its own exports.
export type Pointer = number | bigint;
export type HostFn = (...args: Pointer[]) => Pointer;

// An exported function, such as `_pos2w_gpu_cpu_g`.
export const fn = (M: GpuHost, prefix: string, name: string) => M[`_${prefix}_${name}`] as HostFn;

// A pointer returned by an export, as a heap offset. wasm32 returns pointers as signed
// i32, so those above 2 GB arrive negative.
export const ptr = (p: Pointer) => (typeof p === "bigint" ? Number(p) : p < 0 ? p + 2 ** 32 : p);

// A heap offset in the form the module's exports take.
export const pointerFor = (memory64: boolean) => (n: number): Pointer => (memory64 ? BigInt(n) : n);
