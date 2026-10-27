#pragma once

// Per table phase timings from the last plot, read by the UI through pos2w_phase_ms().
// Upstream's table constructors always accumulate these, they only print them when
// DEVELOPER_PERFORMANCE_TIMINGS is set.

#include <atomic>

namespace pos2w {

enum Phase { kHash = 0, kSort = 1, kFindPairs = 2, kPostSort = 3, kMisc = 4, kNumPhases = 5 };

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
        g_phase_ms[table_][kHash] = t_.hash_time_ms;
        g_phase_ms[table_][kSort] = t_.sort_time_ms;
        g_phase_ms[table_][kFindPairs] = t_.find_pairs_time_ms;
        g_phase_ms[table_][kPostSort] = t_.post_sort_time_ms;
        g_phase_ms[table_][kMisc] = t_.misc_time_ms;
    }
    int table_;
    Timings const& t_;
};

} // namespace pos2w
