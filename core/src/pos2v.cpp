// pos2v: plot validation for the browser, the same steps as `chia plots check`.
//
// For each challenge, chia-blockchain (with chia_rs 0.55, chia-pos2 1.0.1) does:
//   1. Prover(plot).get_qualities_for_challenge(challenge): every quality chain of every
//      plot in the group, each with its plot index, with duplicate chains of the same plot
//      dropped (V2Prover in chia/plotting/prover.py)
//   2. solve_proof(chain, plot_id_for_index(plot_index), strength, k) for each one
//   3. validate_proof_v2(group_id, plot_index, k, strength, meta_group, challenge, proof),
//      whose quality must equal the one from step 1
// This file runs those steps with the same pos2-chip code. The caller computes the
// challenges (sha256 of the 32 byte big endian index) and reads the plot header itself.
//
// Solving runs on a background thread (pos2v_start, then poll pos2v_status) so the
// calling JavaScript thread stays free to service GPU requests from the solver.

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <optional>
#include <span>
#include <string>
#include <thread>
#include <vector>

#include "gpu_bridge.hpp"
#include "pos/ProofCore.hpp"
#include "pos/ProofFragment.hpp"
#include "pos/ProofParams.hpp"
#include "pos/ProofValidator.hpp"
#include "pos/sha/sha256.hpp"
#include "prove/Prover.hpp"
#include "solve/Solver.hpp"

#include <emscripten/emscripten.h>
#define POS2V_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE

namespace {

struct Result {
    int32_t found = 0;
    int32_t solved = 0;
    int32_t valid = 0;
    double prove_ms = 0;
    double solve_ms = 0;
};

enum Status : int32_t { kIdle = 0, kRunning = 1, kDone = 2, kError = -1 };

std::string g_error;
Result g_result;
std::atomic<int32_t> g_status { kIdle };
std::thread g_worker;

double ms_since(std::chrono::steady_clock::time_point t)
{
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t).count();
}

// Finds qualities on the calling thread. The Emscripten file system is not safe to use
// from other threads here: reads proxied to the main thread stall.
bool find_qualities(
    char const* path, std::span<uint8_t const, 32> challenge, std::vector<PlotQualityChains>& out)
{
    auto const t_prove = std::chrono::steady_clock::now();
    try {
        GroupProver prover(path);
        out = prover.prove(challenge);
    }
    catch (std::exception const& e) {
        g_error = std::string("reading plot failed: ") + e.what();
        return false;
    }
    g_result.prove_ms = ms_since(t_prove);
    for (PlotQualityChains& plot: out) {
        std::vector<QualityChain>& chains = plot.quality_chains;
        std::vector<QualityChain> unique;
        unique.reserve(chains.size());
        for (QualityChain const& c: chains) {
            bool const seen = std::any_of(unique.begin(), unique.end(), [&](QualityChain const& u) {
                return u.chain_links == c.chain_links;
            });
            if (!seen) {
                unique.push_back(c);
            }
        }
        chains = std::move(unique);
        g_result.found += static_cast<int32_t>(chains.size());
    }
    return true;
}

// Solves and validates each quality. Runs on a background thread.
void solve_all(std::vector<PlotQualityChains> plots,
    PlotGroupParams group,
    std::array<uint8_t, 32> challenge)
{
    std::span<uint8_t const, 32> const challenge_span(challenge);
    auto const t_solve = std::chrono::steady_clock::now();
    for (PlotQualityChains const& plot: plots) {
        for (QualityChain const& quality: plot.quality_chains) {
            try {
                // solve_partial_proof in pos2-chip's api.cpp: raw params from the plot ID.
                PlotProofParams const params = PlotProofParams::create_raw(
                    group.get_plot_params_for_index(plot.plot_index).get_plot_id(),
                    static_cast<uint8_t>(group.get_k()),
                    static_cast<uint8_t>(group.get_strength()));
                ProofFragmentCodec codec(params);
                std::array<uint32_t, TOTAL_T1_PAIRS_IN_PROOF> x_bits;
                size_t idx = 0;
                for (int i = 0; i < TOTAL_PROOF_FRAGMENTS_IN_PROOF; ++i) {
                    for (uint32_t const x:
                        codec.get_x_bits_from_proof_fragment(quality.chain_links[i])) {
                        x_bits[idx++] = x;
                    }
                }
                Solver solver(params);
                auto full_proofs = solver.solve(x_bits);
                if (full_proofs.empty()) {
                    continue;
                }
                g_result.solved++;

                ProofValidator validator(group, plot.plot_index);
                std::optional<QualityChainLinks> links = validator.validate_full_proof(
                    std::span<uint32_t const, TOTAL_XS_IN_PROOF>(full_proofs[0]), challenge_span);
                if (links && *links == quality.chain_links) {
                    g_result.valid++;
                }
            }
            catch (std::exception const& e) {
                g_error = std::string("solving failed: ") + e.what();
            }
        }
    }
    g_result.solve_ms = ms_since(t_solve);
    g_status = kDone;
}

} // namespace

// Runs one challenge against the plot group file at path. Finding qualities happens before
// this returns, solving continues in the background: poll pos2v_status() until it is no
// longer 1 (running). Returns a negative number if the arguments are rejected, otherwise 0,
// even when the plot cannot be read: that shows up as an error status and pos2v_error().
// plot_group_id and challenge must point to 32 bytes. k, strength and meta_group come from
// the file's header.
POS2V_EXPORT int32_t pos2v_start(char const* path,
    uint8_t const* plot_group_id,
    int32_t k,
    int32_t strength,
    int32_t meta_group,
    uint8_t const* challenge)
{
    if (g_status == kRunning) {
        return -1;
    }
    if (meta_group < 0 || meta_group > 255) {
        return -2;
    }
    std::optional<PlotGroupParams> group;
    try {
        group.emplace(PlotGroupId(plot_group_id),
            static_cast<uint8_t>(k),
            static_cast<uint8_t>(strength),
            static_cast<uint8_t>(meta_group));
    }
    catch (std::exception const&) {
        return -2;
    }
    if (g_worker.joinable()) {
        g_worker.join();
    }
    // Start the task pool on this thread. Creating pthreads from another pthread stalls.
    pos2w::TaskPool::instance().threads();
    g_result = Result {};
    g_error.clear();
    std::array<uint8_t, 32> ch;
    std::memcpy(ch.data(), challenge, 32);
    std::vector<PlotQualityChains> plots;
    if (!find_qualities(path, std::span<uint8_t const, 32>(ch), plots)) {
        g_status = kError;
        return 0;
    }
    g_status = kRunning;
    g_worker = std::thread(solve_all, std::move(plots), *group, ch);
    return 0;
}

// 1 running, 2 done, -1 the plot could not be read (see pos2v_error).
POS2V_EXPORT int32_t pos2v_status() { return g_status.load(); }

POS2V_EXPORT double pos2v_prove_ms() { return g_result.prove_ms; }
POS2V_EXPORT double pos2v_solve_ms() { return g_result.solve_ms; }
POS2V_EXPORT int32_t pos2v_found() { return g_result.found; }
POS2V_EXPORT int32_t pos2v_solved() { return g_result.solved; }
POS2V_EXPORT int32_t pos2v_valid() { return g_result.valid; }
POS2V_EXPORT char const* pos2v_error() { return g_error.c_str(); }

// GPU exports, named pos2v_gpu_*.
#define EXPORT_FN POS2V_EXPORT
#define GPU_PREFIX pos2v
#include "gpu_exports.inc"
