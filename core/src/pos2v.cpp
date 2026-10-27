// pos2v: plot validation for the browser, the same steps as `chia plots check`.
//
// For each challenge, chia_rs (chia-pos2 0.6.0) does:
//   1. qualities_for_challenge(plot, challenge), keeping at most 10 results
//   2. solve_partial_proof(quality, plot_id, k, strength, testnet) for each one
//   3. validate_proof(plot_id, k, strength, challenge, proof, testnet), whose quality
//      must equal the one from step 1
// This file runs those steps with the same pos2-chip code. The caller computes the
// challenges (sha256 of the 32 byte big endian index) and reads the plot header itself.

#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

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

std::string g_error;

struct Result {
    int32_t found = 0;
    int32_t solved = 0;
    int32_t valid = 0;
    double prove_ms = 0;
    double solve_ms = 0;
};

double ms_since(std::chrono::steady_clock::time_point t)
{
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t).count();
}
Result g_result;

} // namespace

// Runs one challenge against the plot at path. Returns 0 on success, or -1 if the plot
// could not be read, in which case pos2v_error() has the reason.
// plot_id and challenge must point to 32 bytes.
POS2V_EXPORT int32_t pos2v_challenge(char const* path,
    uint8_t const* plot_id,
    int32_t k,
    int32_t strength,
    uint8_t const* challenge,
    int32_t testnet)
{
    g_result = Result {};
    g_error.clear();
    std::span<uint8_t const, 32> const challenge_span(challenge, challenge + 32);

    std::vector<QualityChain> qualities;
    auto const t_prove = std::chrono::steady_clock::now();
    try {
        Prover prover(path);
        qualities = prover.prove(challenge_span);
    }
    catch (std::exception const& e) {
        g_error = std::string("reading plot failed: ") + e.what();
        return -1;
    }
    g_result.prove_ms = ms_since(t_prove);
    auto const t_solve = std::chrono::steady_clock::now();
    if (qualities.size() > kMaxQualities) {
        qualities.resize(kMaxQualities);
    }
    g_result.found = static_cast<int32_t>(qualities.size());

    for (QualityChain const& quality: qualities) {
        try {
            ProofParams params(plot_id, uint8_t(k), uint8_t(strength), uint8_t(testnet));
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
    return 0;
}

// Time spent finding qualities and solving plus validating, for the last challenge.
POS2V_EXPORT double pos2v_prove_ms() { return g_result.prove_ms; }
POS2V_EXPORT double pos2v_solve_ms() { return g_result.solve_ms; }

POS2V_EXPORT int32_t pos2v_found() { return g_result.found; }
POS2V_EXPORT int32_t pos2v_solved() { return g_result.solved; }
POS2V_EXPORT int32_t pos2v_valid() { return g_result.valid; }
POS2V_EXPORT char const* pos2v_error() { return g_error.c_str(); }
