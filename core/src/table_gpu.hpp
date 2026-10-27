#pragma once

// GPU path for the matching target hash in table construction. The generated
// TableConstructorGeneric.hpp calls gpu_match_targets before upstream's CPU loop, and the
// CPU loop then handles whatever the GPU did not, so a GPU failure part way through falls
// back cleanly.

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "common/ParallelForRange.hpp"
#include "gpu_bridge.hpp"
#include "pos/ProofParams.hpp"
#include "pos/aes/AesHash.hpp"

namespace pos2w {

// The meta a table's candidates are hashed on: x for table 1, the 2k bit meta otherwise.
template <class T>
uint64_t candidate_meta(T const& c)
{
    if constexpr (requires { c.meta(); }) {
        return c.meta();
    }
    else if constexpr (requires { c.meta; }) {
        return c.meta;
    }
    else {
        return c.x;
    }
}

// Computes out[i] = in[i] with match_info set to its matching target, for as many entries
// as the GPU manages. Returns how many were done, starting from 0.
template <class T>
std::size_t gpu_match_targets(
    ProofParams const& params, int table_id, T const* in, T* out, std::size_t n, uint32_t match_key)
{
    if (!gpu::g_enabled.load() || n == 0) {
        return 0;
    }
    // Chunks keep the transfer buffers bounded (128 MB of metas, 64 MB of targets).
    constexpr std::size_t kChunk = std::size_t(1) << 24;
    std::size_t const chunk = std::min(n, kChunk);
    std::vector<uint64_t> metas(chunk);
    std::vector<uint32_t> targets(chunk);

    // Same parameters as ProofHashing::matching_target: table 1 gets extra rounds by strength.
    int const extra_rounds_bits = table_id == 1 ? params.get_strength() - 2 : 0;
    uint32_t const rounds = uint32_t(AES_MATCHING_TARGET_ROUNDS) << extra_rounds_bits;
    int const bits = static_cast<int>(params.get_num_match_target_bits(table_id));
    uint32_t const mask = bits >= 32 ? 0xffffffffu : ((uint32_t(1) << bits) - 1u);

    std::size_t done = 0;
    while (done < n) {
        std::size_t const m = std::min(chunk, n - done);
        parallel_for_range(std::size_t(0), m, [&](std::size_t i) { metas[i] = candidate_meta(in[done + i]); });

        gpu::Request req {};
        req.op = gpu::kMatchTargets;
        gpu::fill_params(req, params);
        req.table_id = static_cast<uint32_t>(table_id);
        req.match_key = match_key;
        req.rounds = rounds;
        req.mask = mask;
        req.in_ptr = reinterpret_cast<uintptr_t>(metas.data());
        req.out_ptr = reinterpret_cast<uintptr_t>(targets.data());
        req.count = m;
        if (!gpu::call(req)) {
            break;
        }
        parallel_for_range(std::size_t(0), m, [&](std::size_t i) {
            T c = in[done + i];
            c.match_info = targets[i];
            out[done + i] = c;
        });
        done += m;
    }
    return done;
}

} // namespace pos2w
