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
// Every op computes its hashes exactly as ProofHashing does: iterations of two AES
// encryption rounds keyed by the plot ID.

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
    // Find every table pair for one section: for each left candidate at in_ptr (count of
    // them, l_stride words each) and each match key, hash the matching target, binary
    // search the right candidates at r_ptr (split by match key at aux_ptr, num_match_keys
    // + 1 offsets), and keep the pairs that pass the pairing test. JavaScript keeps the
    // results and reports how many in result_count, so C++ can reserve room for them.
    kFindPairs = 3,
    // Copy the results of the last kFindPairs (count entries) to out_ptr.
    kCopyPairs = 4,
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
    uint64_t out_capacity; // in entries, for kFilterBitmask and direct kFindPairs
    uint64_t bitmask_ptr;
    uint64_t result_count;
    double gpu_ms; // filled in by JavaScript
    // kFindPairs parameters. Candidates are copied as raw structs: Xs_Candidate, T1Pairing
    // or T2Pairing for tables 1 to 3, l_stride 32 bit words each.
    uint32_t table_id;
    uint32_t strength;
    uint32_t num_match_keys;
    uint32_t mask; // match target mask
    uint64_t in_ptr; // left candidates
    uint64_t count;
    uint64_t r_ptr; // right candidates
    uint64_t r_count;
    uint64_t aux_ptr; // num_match_keys + 1 uint32 offsets into the right candidates
    uint32_t l_stride;
    // 1: write pairs straight to out_ptr (room for out_capacity) as they are found, instead
    // of holding them for kCopyPairs. Only when nothing else appends to the output.
    uint32_t direct;
    // Table 3 encodes proof fragments with the Feistel cipher: per round, the key's three
    // k bit words (low, middle, high), as FeistelCipher::feistel_round splits them.
    uint32_t feistel_keys[12];
};

// Every offset, as listed in `R` in web/src/lib/gpu/serve.ts.
static_assert(offsetof(Request, state) == 0 && offsetof(Request, op) == 4
        && offsetof(Request, k) == 8 && offsetof(Request, xor_const) == 12
        && offsetof(Request, key1) == 16 && offsetof(Request, key2) == 32
        && offsetof(Request, bitmask_shift) == 48 && offsetof(Request, bitmask_words) == 52
        && offsetof(Request, out_ptr) == 56 && offsetof(Request, out_capacity) == 64
        && offsetof(Request, bitmask_ptr) == 72 && offsetof(Request, result_count) == 80
        && offsetof(Request, gpu_ms) == 88 && offsetof(Request, table_id) == 96
        && offsetof(Request, strength) == 100 && offsetof(Request, num_match_keys) == 104
        && offsetof(Request, mask) == 108 && offsetof(Request, in_ptr) == 112
        && offsetof(Request, count) == 120 && offsetof(Request, r_ptr) == 128
        && offsetof(Request, r_count) == 136 && offsetof(Request, aux_ptr) == 144
        && offsetof(Request, l_stride) == 152 && offsetof(Request, direct) == 156
        && offsetof(Request, feistel_keys) == 160 && sizeof(Request) == 208,
    "Request layout is mirrored in web/src/lib/gpu/serve.ts");

inline Request g_request {};
inline std::atomic<bool> g_enabled { false };
inline std::mutex g_mutex; // one request at a time
inline std::atomic<double> g_total_ms { 0 };

// How table pairs are found when a GPU is attached.
enum PairsMode : int32_t { kPairsCpu = 0, kPairsGpu = 1, kPairsHybrid = 2 };
inline std::atomic<int32_t> g_pairs_mode { kPairsGpu };
// Hybrid mode: the share of each section's left candidates given to the GPU, indexed by
// table ID (1 to 3, entry 0 is unused). Adjusted after every section so the CPU and GPU
// finish together, and kept across plots.
inline std::atomic<double> g_split[4] = { 0.7, 0.7, 0.7, 0.7 };

inline void fill_params(Request& r, ProofParams const& params)
{
    uint8_t const* id = params.get_plot_id_bytes();
    // AesHash::load_plot_id_as_aes_key reads the bytes as little endian 32 bit words.
    std::memcpy(r.key1, id, 16);
    std::memcpy(r.key2, id + 16, 16);
    r.k = static_cast<uint32_t>(params.get_k());
    r.xor_const = params.is_testnet() ? TESTNET_G_XOR_CONST : 0;
}

// A request in flight. submit() returns as soon as JavaScript has been told, so the caller
// can do CPU work while the GPU runs, then wait() for the result. Holds the request lock
// in between, so other GPU users wait their turn.
class AsyncCall {
public:
    AsyncCall() = default;
    AsyncCall(AsyncCall const&) = delete;
    AsyncCall& operator=(AsyncCall const&) = delete;
    ~AsyncCall()
    {
        if (active_) {
            Request r {};
            wait(r);
        }
    }

    bool active() const { return active_; }

    // Returns false, without submitting, when no GPU is attached.
    bool submit(Request const& r)
    {
#if defined(__EMSCRIPTEN__)
        if (!g_enabled.load()) {
            return false;
        }
        lock_ = std::unique_lock<std::mutex>(g_mutex);
        Request& shared = g_request;
        // Copy everything but state, then publish with a release store on state.
        std::memcpy(reinterpret_cast<char*>(&shared) + sizeof(int32_t),
            reinterpret_cast<char const*>(&r) + sizeof(int32_t),
            sizeof(Request) - sizeof(int32_t));
        std::atomic_ref<int32_t> state(shared.state);
        state.store(kRequested, std::memory_order_release);
        emscripten_futex_wake(&shared.state, 1 << 30);
        active_ = true;
        return true;
#else
        (void)r;
        return false;
#endif
    }

    // Waits for the submitted request. Returns true if the GPU did the work, and copies
    // result_count and gpu_ms into r.
    bool wait(Request& r)
    {
#if defined(__EMSCRIPTEN__)
        if (!active_) {
            return false;
        }
        Request& shared = g_request;
        std::atomic_ref<int32_t> state(shared.state);
        while (state.load(std::memory_order_acquire) == kRequested) {
            emscripten_futex_wait(&shared.state, kRequested, 1000.0);
        }
        bool const ok = state.load() == kDone;
        r.result_count = shared.result_count;
        r.gpu_ms = shared.gpu_ms;
        state.store(kIdle);
        if (ok) {
            // Under the request lock, so concurrent callers cannot lose each other's time.
            g_total_ms.store(g_total_ms.load() + r.gpu_ms);
        }
        else {
            // Do not keep asking a GPU that just failed.
            g_enabled = false;
        }
        active_ = false;
        lock_.unlock();
        return ok;
#else
        (void)r;
        return false;
#endif
    }

private:
    std::unique_lock<std::mutex> lock_;
    bool active_ = false;
};

// Submits r and waits for JavaScript. Returns true if the GPU did the work.
inline bool call(Request& r)
{
    AsyncCall c;
    return c.submit(r) && c.wait(r);
}

} // namespace pos2w::gpu
