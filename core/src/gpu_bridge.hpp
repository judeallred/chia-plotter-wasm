#pragma once

// Lets plotting threads hand g(x) work to WebGPU.
//
// WebGPU is an asynchronous JavaScript API, so C++ cannot call it directly from a plotting
// thread. Instead a thread fills in the shared Request below, sets state to kRequested, and
// waits on a futex. The worker's JavaScript (gpu.ts) watches state with Atomics.waitAsync,
// runs the work on the GPU, writes results straight into WASM memory, then sets state to
// kDone or kFailed and notifies. On kFailed, or when no GPU is attached, callers run their
// normal CPU code, so results never depend on whether a GPU was used.
//
// Every op computes g(x) exactly as ProofHashing::g does: 16 iterations of two AES
// encryption rounds keyed by the plot ID, after the testnet XOR, masked to k bits.

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <mutex>

#include "pos/ProofConstants.hpp"
#include "pos/ProofParams.hpp"

#if defined(__EMSCRIPTEN__)
#include <emscripten/threading.h>
#endif

namespace pos2w::gpu {

enum State : int32_t { kIdle = 0, kRequested = 1, kDone = 2, kFailed = 3 };

enum Op : int32_t {
    // Write {g(x), x} pairs for x in [0, 2^k) to out, in x order (Xs_Candidate layout).
    kFillXs = 1,
    // Write {x, g(x)} for every x whose bitmask bit (g(x) >> shift) is set, in any order.
    // result_count receives the number of matches, even if it exceeds out_capacity.
    kFilterBitmask = 2,
    // For each of count 64 bit metas at in_ptr, write the 32 bit matching target to out_ptr:
    // `rounds` iterations of the two AES rounds on the state {table_id, match_key, meta lo,
    // meta hi}, lane 0 masked with mask (AesHash::matching_target).
    kMatchTargets = 3,
};

// Field order and sizes are mirrored in web/src/lib/gpu.ts. Keep them in sync.
struct Request {
    int32_t state;
    int32_t op;
    uint32_t k;
    uint32_t xor_const;
    uint32_t key1[4];
    uint32_t key2[4];
    uint32_t bitmask_shift;
    uint32_t bitmask_words;
    uint64_t out_ptr;
    uint64_t out_capacity; // in entries, for kFilterBitmask
    uint64_t bitmask_ptr;
    uint64_t result_count;
    double gpu_ms; // filled in by JavaScript
    // kMatchTargets parameters.
    uint32_t table_id;
    uint32_t match_key;
    uint32_t rounds;
    uint32_t mask;
    uint64_t in_ptr;
    uint64_t count;
};

static_assert(offsetof(Request, key1) == 16 && offsetof(Request, bitmask_shift) == 48
    && offsetof(Request, out_ptr) == 56 && offsetof(Request, result_count) == 80
    && offsetof(Request, gpu_ms) == 88 && offsetof(Request, table_id) == 96
    && offsetof(Request, in_ptr) == 112 && offsetof(Request, count) == 120 && sizeof(Request) == 128,
    "Request layout is mirrored in web/src/lib/gpu.ts");

inline Request g_request {};
inline std::atomic<bool> g_enabled { false };
inline std::mutex g_mutex; // one request at a time
inline std::atomic<double> g_total_ms { 0 };

inline void fill_params(Request& r, ProofParams const& params)
{
    uint8_t const* id = params.get_plot_id_bytes();
    // AesHash::load_plot_id_as_aes_key reads the bytes as little endian 32 bit words.
    std::memcpy(r.key1, id, 16);
    std::memcpy(r.key2, id + 16, 16);
    r.k = static_cast<uint32_t>(params.get_k());
    r.xor_const = params.is_testnet() ? TESTNET_G_XOR_CONST : 0;
}

// Submits r and waits for JavaScript. Returns true if the GPU did the work.
inline bool call(Request& r)
{
#if defined(__EMSCRIPTEN__)
    if (!g_enabled.load()) {
        return false;
    }
    std::lock_guard<std::mutex> lock(g_mutex);
    Request& shared = g_request;
    // Copy everything but state, then publish with a release store on state.
    std::memcpy(reinterpret_cast<char*>(&shared) + sizeof(int32_t),
        reinterpret_cast<char const*>(&r) + sizeof(int32_t), sizeof(Request) - sizeof(int32_t));
    auto* state = reinterpret_cast<std::atomic<int32_t>*>(&shared.state);
    state->store(kRequested, std::memory_order_release);
    emscripten_futex_wake(&shared.state, 1 << 30);
    while (state->load(std::memory_order_acquire) == kRequested) {
        emscripten_futex_wait(&shared.state, kRequested, 1000.0);
    }
    bool const ok = state->load() == kDone;
    r.result_count = shared.result_count;
    r.gpu_ms = shared.gpu_ms;
    state->store(kIdle);
    if (ok) {
        g_total_ms.store(g_total_ms.load() + r.gpu_ms);
    }
    else {
        // Do not keep asking a GPU that just failed.
        g_enabled = false;
    }
    return ok;
#else
    (void)r;
    return false;
#endif
}

} // namespace pos2w::gpu
