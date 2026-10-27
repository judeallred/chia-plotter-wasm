// pos2v: plot validation for the browser, the same steps as `chia plots check`.
//
// For each challenge, chia_rs (chia-pos2 0.6.0) does:
//   1. qualities_for_challenge(plot, challenge), keeping at most 10 results
//   2. solve_partial_proof(quality, plot_id, k, strength, testnet) for each one
//   3. validate_proof(plot_id, k, strength, challenge, proof, testnet), whose quality
//      must equal the one from step 1
// This file runs those steps with the same pos2-chip code. The caller computes the
// challenges (sha256 of the 32 byte big endian index) and reads the plot header itself.
//
// Solving runs on a background thread (pos2v_start, then poll pos2v_status) so the
// calling JavaScript thread stays free to service GPU requests from the solver.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "gpu_bridge.hpp"
#include "pos/ProofCore.hpp"
#include "pos/ProofFragment.hpp"
#include "pos/ProofParams.hpp"
#include "pos/ProofValidator.hpp"
#include "prove/Prover.hpp"
#include "solve/Solver.hpp"

#include <emscripten/emscripten.h>
#define POS2V_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE

namespace {

// chia-pos2 caps the qualities it returns per challenge at 10.
constexpr uint32_t kMaxQualities = 10;

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
bool find_qualities(char const* path, std::span<uint8_t const, 32> challenge, std::vector<QualityChain>& out)
{
    auto const t_prove = std::chrono::steady_clock::now();
    try {
        Prover prover(path);
        out = prover.prove(challenge);
    }
    catch (std::exception const& e) {
        g_error = std::string("reading plot failed: ") + e.what();
        return false;
    }
    g_result.prove_ms = ms_since(t_prove);
    if (out.size() > kMaxQualities) {
        out.resize(kMaxQualities);
    }
    g_result.found = static_cast<int32_t>(out.size());
    return true;
}

// Solves and validates each quality. Runs on a background thread.
void solve_all(std::vector<QualityChain> qualities,
    std::array<uint8_t, 32> plot_id,
    int32_t k,
    int32_t strength,
    std::array<uint8_t, 32> challenge,
    int32_t testnet)
{
    std::span<uint8_t const, 32> const challenge_span(challenge);
    auto const t_solve = std::chrono::steady_clock::now();
    for (QualityChain const& quality: qualities) {
        try {
            ProofParams params(plot_id.data(), uint8_t(k), uint8_t(strength), uint8_t(testnet));
            ProofFragmentCodec codec(params);
            std::array<uint32_t, TOTAL_T1_PAIRS_IN_PROOF> x_bits;
            size_t idx = 0;
            for (int i = 0; i < TOTAL_PROOF_FRAGMENTS_IN_PROOF; ++i) {
                for (uint32_t const x: codec.get_x_bits_from_proof_fragment(quality.chain_links[i])) {
                    x_bits[idx++] = x;
                }
            }
            Solver solver(params);
            auto full_proofs = solver.solve(x_bits);
            if (full_proofs.empty()) {
                continue;
            }
            g_result.solved++;

            ProofValidator validator(params);
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
    g_result.solve_ms = ms_since(t_solve);
    g_status = kDone;
}

} // namespace

// Runs one challenge against the plot at path. Finding qualities happens before this
// returns, solving continues in the background: poll pos2v_status() until it is no longer
// 1 (running). Returns 0 if accepted. plot_id and challenge must point to 32 bytes.
POS2V_EXPORT int32_t pos2v_start(char const* path,
    uint8_t const* plot_id,
    int32_t k,
    int32_t strength,
    uint8_t const* challenge,
    int32_t testnet)
{
    if (g_status == kRunning) {
        return -1;
    }
    if (g_worker.joinable()) {
        g_worker.join();
    }
    // Start the task pool on this thread. Creating pthreads from another pthread stalls.
    pos2w::TaskPool::instance().threads();
    g_result = Result {};
    g_error.clear();
    std::array<uint8_t, 32> id, ch;
    std::memcpy(id.data(), plot_id, 32);
    std::memcpy(ch.data(), challenge, 32);
    std::vector<QualityChain> qualities;
    if (!find_qualities(path, std::span<uint8_t const, 32>(ch), qualities)) {
        g_status = kError;
        return 0;
    }
    g_status = kRunning;
    g_worker = std::thread(solve_all, std::move(qualities), id, k, strength, ch, testnet);
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

#define EXPORT_FN POS2V_EXPORT
#define gpu_request_ptr pos2v_gpu_request_ptr
#define gpu_enable pos2v_gpu_enable
#define gpu_enabled pos2v_gpu_enabled
#define gpu_total_ms pos2v_gpu_total_ms
#define gpu_reset_total pos2v_gpu_reset_total
#define gpu_cpu_g pos2v_gpu_cpu_g
#include "gpu_exports.inc"
