#pragma once

// GPU and hybrid pair finding for table construction.
//
// Upstream's TableConstructorGeneric walks the sections in order, and for each one loops
// over match keys: hash every left candidate to its matching target, sort, and merge with
// the right candidates. The generated TableConstructorGeneric.hpp creates a GpuSection
// before that loop. It hands the first part of the section's left candidates to the GPU,
// which does the hash, a directory lookup instead of the sort and merge, and the pairing
// test. In hybrid mode the CPU loop runs on the rest while the GPU works, and finish()
// copies the GPU's pairs into the shared output. In GPU mode the GPU takes everything and
// writes its pairs into the output directly.
//
// Output order does not matter: every table sorts its pairs afterwards, and the CPU path
// already appends from many threads in no fixed order. Plots stay byte identical.

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <vector>

#include "common/ParallelForRange.hpp"
#include "gpu_bridge.hpp"
#include "pos/FeistelCipher.hpp"
#include "pos/ProofParams.hpp"

namespace pos2w {

// Round keys for FeistelCipher::encrypt, split into the three k bit words each round uses.
inline void feistel_round_keys(ProofParams const& params, uint32_t out[12])
{
    std::size_t const k = params.get_k();
    FeistelCipher cipher(params.get_plot_id_bytes(), k);
    uint64_t const mask = (uint64_t(1) << k) - 1;
    for (std::size_t r = 0; r < 4; ++r) {
        uint64_t const key = cipher.get_round_key(r);
        out[3 * r + 0] = static_cast<uint32_t>(key & mask);
        out[3 * r + 1] = static_cast<uint32_t>((key >> k) & mask);
        out[3 * r + 2] = static_cast<uint32_t>((key >> (2 * k)) & mask);
    }
}

template <class Ctor, class C, class P>
class GpuSection {
    static_assert(sizeof(C) % 4 == 0 && sizeof(P) % 4 == 0);

public:
    GpuSection(Ctor& ctor,
        ProofParams const& params,
        int table_id,
        std::span<C const> prev,
        uint64_t const* l_row,
        uint64_t const* r_row,
        std::size_t num_match_keys,
        std::span<P> out,
        std::atomic<std::size_t>& out_count)
        : ctor_(ctor)
        , table_id_(table_id)
        , prev_(prev)
        , r_row_(r_row)
        , num_match_keys_(num_match_keys)
        , out_(out)
        , out_count_(out_count)
        , l_begin_(l_row[0])
        , l_total_(l_row[num_match_keys] - l_row[0])
    {
        int32_t const mode = gpu::g_pairs_mode.load();
        std::size_t const r_total = r_row[num_match_keys] - r_row[0];
        if (!gpu::g_enabled.load() || mode == gpu::kPairsCpu || l_total_ == 0 || r_total == 0) {
            return;
        }
        hybrid_ = mode == gpu::kPairsHybrid;
        double const share = hybrid_ ? gpu::g_split[table_id].load() : 1.0;
        gpu_l_ = std::min(l_total_, static_cast<std::size_t>(share * double(l_total_)));
        if (gpu_l_ == 0) {
            return;
        }

        prefix_.resize(num_match_keys + 1);
        for (std::size_t i = 0; i <= num_match_keys; ++i) {
            prefix_[i] = static_cast<uint32_t>(r_row[i] - r_row[0]);
        }

        gpu::Request req {};
        req.op = gpu::kFindPairs;
        gpu::fill_params(req, params);
        req.table_id = static_cast<uint32_t>(table_id);
        req.strength = params.get_strength();
        req.num_match_keys = static_cast<uint32_t>(num_match_keys);
        int const bits = static_cast<int>(params.get_num_match_target_bits(table_id));
        req.mask = bits >= 32 ? 0xffffffffu : ((uint32_t(1) << bits) - 1u);
        req.in_ptr = reinterpret_cast<uintptr_t>(prev.data() + l_begin_);
        req.count = gpu_l_;
        req.r_ptr = reinterpret_cast<uintptr_t>(prev.data() + r_row[0]);
        req.r_count = r_total;
        req.aux_ptr = reinterpret_cast<uintptr_t>(prefix_.data());
        req.l_stride = sizeof(C) / 4;
        if (table_id == 3) {
            feistel_round_keys(params, req.feistel_keys);
        }
        if (!hybrid_) {
            // Nothing else appends during this section, so the GPU can write in place. That
            // saves holding a section's pairs (1 GB at k28) until the copy.
            std::size_t const at = out_count.load();
            req.direct = 1;
            req.out_ptr = reinterpret_cast<uintptr_t>(out.data() + at);
            req.out_capacity = out.size() > at ? out.size() - at : 0;
        }
        if (!call_.submit(req)) {
            gpu_l_ = 0;
            return;
        }
        start_ = std::chrono::steady_clock::now();
    }

    // Left candidates taken by the GPU, from the start of the section. The CPU loop starts
    // after them.
    std::size_t gpu_count() const { return gpu_l_; }

    // Waits for the GPU and appends its pairs to the output. If the GPU failed, finds its
    // share of the pairs on the CPU instead. Returns the milliseconds spent here.
    double finish()
    {
        if (!call_.active()) {
            return 0;
        }
        auto const now = std::chrono::steady_clock::now();
        double const cpu_ms = std::chrono::duration<double, std::milli>(now - start_).count();
        gpu::Request res {};
        if (!call_.wait(res)) {
            cpu_fallback();
        }
        else {
            collect(res, cpu_ms);
        }
        return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - now).count();
    }

private:
    void collect(gpu::Request const& res, double cpu_ms)
    {
        std::size_t const n = res.result_count;
        if (!hybrid_) {
            out_count_.fetch_add(n);
            return;
        }
        std::size_t const idx = out_count_.fetch_add(n);
        // On overflow, upstream's capacity check after the loop reports the error.
        if (n > 0 && idx + n <= out_.size()) {
            gpu::Request copy {};
            copy.op = gpu::kCopyPairs;
            copy.out_ptr = reinterpret_cast<uintptr_t>(out_.data() + idx);
            copy.count = n;
            if (!gpu::call(copy)) {
                // The reserved slots cannot be given back, so this plot cannot finish.
                throw std::runtime_error("GPU failed while returning table pairs");
            }
        }
        if (hybrid_) {
            rebalance(res.gpu_ms, cpu_ms);
        }
    }

    // Moves the split towards the point where both sides take the same time.
    void rebalance(double gpu_ms, double cpu_ms)
    {
        std::size_t const cpu_l = l_total_ - gpu_l_;
        if (gpu_ms <= 0 || cpu_ms <= 0 || cpu_l == 0) {
            return;
        }
        double const gpu_rate = double(gpu_l_) / gpu_ms;
        double const cpu_rate = double(cpu_l) / cpu_ms;
        double const target = gpu_rate / (gpu_rate + cpu_rate);
        double const next = 0.5 * gpu::g_split[table_id_].load() + 0.5 * target;
        gpu::g_split[table_id_] = std::clamp(next, 0.05, 0.98);
    }

    // Upstream's per match key steps for the GPU's share, used only if the GPU fails.
    void cpu_fallback()
    {
        std::vector<C> l(gpu_l_);
        for (uint32_t mk = 0; mk < num_match_keys_; ++mk) {
            std::span<C const> r(prev_.data() + r_row_[mk], r_row_[mk + 1] - r_row_[mk]);
            if (r.empty()) {
                continue;
            }
            parallel_for_range(std::size_t(0), gpu_l_, [&](std::size_t i) {
                l[i] = ctor_.matching_target(prev_[l_begin_ + i], mk);
            });
            std::sort(l.begin(), l.end(), [](C const& a, C const& b) { return a.match_info < b.match_info; });
            ctor_.find_pairs_into(std::span<C const>(l), r, out_, out_count_);
        }
    }

    Ctor& ctor_;
    int table_id_;
    std::span<C const> prev_;
    uint64_t const* r_row_;
    std::size_t num_match_keys_;
    std::span<P> out_;
    std::atomic<std::size_t>& out_count_;
    std::size_t l_begin_;
    std::size_t l_total_;
    std::size_t gpu_l_ = 0;
    bool hybrid_ = false;
    std::vector<uint32_t> prefix_;
    gpu::AsyncCall call_;
    std::chrono::steady_clock::time_point start_;
};

} // namespace pos2w
