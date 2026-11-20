// Plotter only GPU exports, mostly CPU references for the pair self test. Included by
// pos2w.cpp after gpu_exports.inc.

// CPU reference for one matching target, for the GPU self test.
EXPORT_FN uint32_t GPU_FN(gpu_cpu_match_target)(uint8_t const* plot_id,
    int32_t k,
    int32_t strength,
    int32_t table_id,
    uint32_t match_key,
    uint32_t meta_lo,
    uint32_t meta_hi)
{
    PlotProofParams const params
        = PlotProofParams::create_raw(PlotId(plot_id), uint8_t(k), uint8_t(strength));
    ProofCore core(params);
    return core.matching_target(size_t(table_id), (uint64_t(meta_hi) << 32) | meta_lo, match_key);
}

// Matching target mask width for a table, for the GPU self test.
EXPORT_FN int32_t GPU_FN(gpu_match_target_bits)(int32_t k, int32_t strength, int32_t table_id)
{
    PlotProofParams const params
        = PlotProofParams::create_raw(PlotId(), uint8_t(k), uint8_t(strength));
    return static_cast<int32_t>(params.get_num_match_target_bits(table_id));
}

// How tables find pairs while a GPU is attached: 0 CPU, 1 GPU, 2 CPU and GPU together.
EXPORT_FN void GPU_FN(gpu_set_pairs_mode)(int32_t mode) { pos2w::gpu::g_pairs_mode = mode; }

// Hybrid mode's current GPU share of table 1 to 3 work, from 0 to 1.
EXPORT_FN double GPU_FN(gpu_split)(int32_t table)
{
    return table >= 1 && table <= 3 ? pos2w::gpu::g_split[table].load() : 0;
}

// Table 3's Feistel round keys for a plot ID, 12 words, for the GPU self test.
EXPORT_FN void GPU_FN(gpu_feistel_keys)(uint8_t const* plot_id, int32_t k, uint32_t* out)
{
    PlotProofParams const params = PlotProofParams::create_raw(PlotId(plot_id), uint8_t(k), 2);
    pos2w::feistel_round_keys(params, out);
}

// CPU reference for one pairing test, for the GPU self test. l and r point at raw
// candidates of the table's input type. Writes the output struct to out and returns 1 if
// the pair passes, 0 if not.
EXPORT_FN int32_t GPU_FN(gpu_cpu_pair)(uint8_t const* plot_id,
    int32_t k,
    int32_t strength,
    int32_t table_id,
    void const* l,
    void const* r,
    void* out)
{
    PlotProofParams const params
        = PlotProofParams::create_raw(PlotId(plot_id), uint8_t(k), uint8_t(strength));
    ProofCore core(params);
    if (table_id == 1) {
        auto const* a = static_cast<Xs_Candidate const*>(l);
        auto const* b = static_cast<Xs_Candidate const*>(r);
        auto res = core.pairing_t1(a->x, b->x);
        if (res)
            std::memcpy(out, &*res, sizeof(*res));
        return res ? 1 : 0;
    }
    if (table_id == 2) {
        auto const* a = static_cast<T1Pairing const*>(l);
        auto const* b = static_cast<T1Pairing const*>(r);
        auto res = core.pairing_t2(a->meta(), b->meta());
        if (res)
            std::memcpy(out, &*res, sizeof(*res));
        return res ? 1 : 0;
    }
    auto const* a = static_cast<T2Pairing const*>(l);
    auto const* b = static_cast<T2Pairing const*>(r);
    auto res = core.pairing_t3(a->meta, b->meta, a->x_bits, b->x_bits);
    if (res)
        std::memcpy(out, &*res, sizeof(*res));
    return res ? 1 : 0;
}
