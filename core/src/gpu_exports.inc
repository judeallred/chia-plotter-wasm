// C exports for the GPU bridge, included by pos2w.cpp and pos2v.cpp.

// Address of the shared request JavaScript services. See gpu_bridge.hpp.
EXPORT_FN uintptr_t gpu_request_ptr() { return reinterpret_cast<uintptr_t>(&pos2w::gpu::g_request); }

// Call with 1 once JavaScript has a GPU device and is watching the request, 0 to stop.
EXPORT_FN void gpu_enable(int32_t on) { pos2w::gpu::g_enabled = on != 0; }

// 1 if the GPU is still enabled. It turns itself off after any failure.
EXPORT_FN int32_t gpu_enabled() { return pos2w::gpu::g_enabled ? 1 : 0; }

// Total GPU time reported for completed requests, in milliseconds.
EXPORT_FN double gpu_total_ms() { return pos2w::gpu::g_total_ms.load(); }
EXPORT_FN void gpu_reset_total() { pos2w::gpu::g_total_ms = 0; }

// CPU reference for g(x), used to self test the GPU before trusting it.
EXPORT_FN uint32_t gpu_cpu_g(uint8_t const* plot_id, int32_t k, int32_t testnet, uint32_t x)
{
    ProofParams params(plot_id, uint8_t(k), 2, uint8_t(testnet));
    ProofCore core(params);
    return core.hashing.g(x);
}

// CPU reference for one matching target, for the GPU self test.
EXPORT_FN uint32_t gpu_cpu_match_target(uint8_t const* plot_id,
    int32_t k,
    int32_t strength,
    int32_t table_id,
    uint32_t match_key,
    uint32_t meta_lo,
    uint32_t meta_hi)
{
    ProofParams params(plot_id, uint8_t(k), uint8_t(strength), 0);
    ProofCore core(params);
    return core.matching_target(size_t(table_id), (uint64_t(meta_hi) << 32) | meta_lo, match_key);
}

// Matching target mask width for a table, for the GPU self test.
EXPORT_FN int32_t gpu_match_target_bits(int32_t k, int32_t strength, int32_t table_id)
{
    uint8_t id[32] = {};
    ProofParams params(id, uint8_t(k), uint8_t(strength), 0);
    return static_cast<int32_t>(params.get_num_match_target_bits(table_id));
}
