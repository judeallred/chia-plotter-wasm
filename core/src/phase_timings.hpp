#pragma once

// Per table phase timings from the last plot, read by the UI through pos2w_phase_ms().
// Upstream's table constructors always accumulate these, they only print them when
// DEVELOPER_PERFORMANCE_TIMINGS is set.

#include <atomic>

namespace pos2w {

// Prefixed so they do not collide with the GPU ops in pos2w::gpu (gpu::kFindPairs).
enum Phase {
    kPhaseHash = 0,
    kPhaseSort = 1,
    kPhaseFindPairs = 2,
    kPhasePostSort = 3,
    kPhaseMisc = 4,
    kNumPhases = 5
};

// [table][phase] in milliseconds. Table 0 is Xs, which only has hash and sort.
inline std::atomic<double> g_phase_ms[4][kNumPhases];

inline void reset_phases()
{
    for (auto& t: g_phase_ms)
        for (auto& v: t)
            v = 0;
}

// Copies a table constructor's timings into g_phase_ms when the plot run finishes.
template <typename Timings>
struct PhaseRecorder {
    PhaseRecorder(int table, Timings const& t) : table_(table), t_(t) {}
    ~PhaseRecorder()
    {
        g_phase_ms[table_][kPhaseHash] = t_.hash_time_ms;
        g_phase_ms[table_][kPhaseSort] = t_.sort_time_ms;
        // XsConstructor's timings only have hash and sort.
        if constexpr (requires { t_.find_pairs_time_ms; }) {
            g_phase_ms[table_][kPhaseFindPairs] = t_.find_pairs_time_ms;
            g_phase_ms[table_][kPhasePostSort] = t_.post_sort_time_ms;
            g_phase_ms[table_][kPhaseMisc] = t_.misc_time_ms;
        }
    }
    int table_;
    Timings const& t_;
};

} // namespace pos2w
