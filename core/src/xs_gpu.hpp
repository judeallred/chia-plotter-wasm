#pragma once

// XsConstructor with an optional GPU path for the g(x) pass. The generated Plotter.hpp
// uses this class in place of XsConstructor. Sorting and everything after it are unchanged.

#include "TableConstructorGeneric.hpp"
#include "gpu_bridge.hpp"

namespace pos2w {

class GpuXsConstructor : public XsConstructor {
public:
    using XsConstructor::XsConstructor;

    std::span<Xs_Candidate> construct(std::span<Xs_Candidate> out_xs,
        std::span<Xs_Candidate> tmp_xs,
        std::pmr::memory_resource& scratch_mr)
    {
        uint64_t const num_xs_u64 = (1ULL << params_.get_k());
        size_t const num_xs = static_cast<size_t>(num_xs_u64);

        ScopedEvent xs_scope(sink_,
            ProgressEvent {
                .kind = EventKind::TableBegin, .table_id = 0, .num_items_in = num_xs_u64 });
        if (xs_scope.cancelled())
            return {};

        if (out_xs.size() < num_xs || tmp_xs.size() < num_xs) {
            throw std::runtime_error("XsConstructor: buffers too small");
        }
        auto out_span = out_xs.first(num_xs);
        auto tmp_span = tmp_xs.first(num_xs);

        Timer timer;
        timer.start("Hashing Xs_Candidate");
        static_assert(sizeof(Xs_Candidate) == 8 && offsetof(Xs_Candidate, match_info) == 0
            && offsetof(Xs_Candidate, x) == 4);
        gpu::Request req {};
        req.op = gpu::kFillXs;
        gpu::fill_params(req, params_);
        req.out_ptr = reinterpret_cast<uintptr_t>(out_span.data());
        bool const on_gpu = gpu::call(req);
        if (!on_gpu) {
            parallel_for_range(uint64_t(0), num_xs_u64, [this, out_span](uint64_t x_val) mutable {
                uint32_t x = static_cast<uint32_t>(x_val);
                uint32_t match_info = this->proof_core_.hashing.g(x);
                out_span[static_cast<size_t>(x_val)] = Xs_Candidate { match_info, x };
            });
        }
        timings.hash_time_ms = timer.stop();
        used_gpu = on_gpu;

        RadixSort<Xs_Candidate, uint32_t> radix_sort;
        ScopedEvent sort_scope(sink_,
            ProgressEvent {
                .kind = EventKind::PostSortBegin, .table_id = 0, .produced = num_xs_u64 });
        timer.start("Sorting Xs_Candidate");
        std::span<Xs_Candidate> sorted_span
            = radix_sort.sort(out_span, tmp_span, params_.get_k(), &scratch_mr);
        timings.sort_time_ms = timer.stop();
        return sorted_span;
    }

    bool used_gpu = false;
};

} // namespace pos2w
