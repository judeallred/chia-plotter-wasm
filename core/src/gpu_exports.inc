// C exports for the GPU bridge, included by pos2w.cpp and pos2v.cpp. The including file
// defines EXPORT_FN and GPU_PREFIX, and every function is exported as <prefix>_<name>.

#define POS2W_CAT2(a, b) a##_##b
#define POS2W_CAT(a, b) POS2W_CAT2(a, b)
#define GPU_FN(name) POS2W_CAT(GPU_PREFIX, name)

// Address of the shared request JavaScript services. See gpu_bridge.hpp.
EXPORT_FN uintptr_t GPU_FN(gpu_request_ptr)()
{
    return reinterpret_cast<uintptr_t>(&pos2w::gpu::g_request);
}

// Call with 1 once JavaScript has a GPU device and is watching the request, 0 to stop.
EXPORT_FN void GPU_FN(gpu_enable)(int32_t on) { pos2w::gpu::g_enabled = on != 0; }

// 1 if the GPU is still enabled. It turns itself off after any failure.
EXPORT_FN int32_t GPU_FN(gpu_enabled)() { return pos2w::gpu::g_enabled ? 1 : 0; }

// Total GPU time reported for completed requests, in milliseconds.
EXPORT_FN double GPU_FN(gpu_total_ms)() { return pos2w::gpu::g_total_ms.load(); }
EXPORT_FN void GPU_FN(gpu_reset_total)() { pos2w::gpu::g_total_ms = 0; }

// CPU reference for g(x), used to self test the GPU before trusting it.
EXPORT_FN uint32_t GPU_FN(gpu_cpu_g)(uint8_t const* plot_id, int32_t k, uint32_t x)
{
    PlotProofParams const params = PlotProofParams::create_raw(PlotId(plot_id), uint8_t(k), 2);
    ProofCore core(params);
    return core.hashing.g(x);
}
