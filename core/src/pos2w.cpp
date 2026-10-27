// pos2w: a small C API around the pos2-chip 0.6.0 plotter, built for WebAssembly.
//
// The plot runs on a background thread so the caller (a Web Worker) stays free to poll
// progress. When plotting finishes, the caller pulls the plot file out piece by piece:
//
//   1. pos2w_begin_write() chunks the proof fragments and returns the header size.
//   2. pos2w_next_chunk() compresses and returns one chunk body at a time.
//   3. pos2w_header() returns the final header, including the chunk offset table.
//
// The caller writes header_size placeholder bytes, then every chunk in order, then
// overwrites the start of the file with the header. The resulting bytes are identical to
// PlotFile::writeData from pos2-chip, which is what chia_rs 0.49 reads.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "plot/ChunkCompressor.hpp"
#include "plot/PlotData.hpp"
#include "plot/PlotFile.hpp"
#include "plot/Plotter.hpp"
#include "plot/Progress.hpp"
#include "pos/ProofParams.hpp"
#include "gpu_bridge.hpp"

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#include <emscripten/console.h>
#define POS2W_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define POS2W_EXPORT extern "C"
#endif

namespace {

enum Status : int32_t {
    kIdle = 0,
    kRunning = 1,
    kPlotted = 2,
    kWriting = 3,
    kDone = 4,
    kError = -1,
    kCancelled = -2,
};

// Wraps AtomicProgressSink so we can add cancellation and per-table timings.
class Sink final : public IProgressSink {
public:
    bool on_event(ProgressEvent const& e) noexcept override
    {
        inner_.on_event(e);
#if POS2W_DEBUG
        emscripten_console_logf("event kind=%d table=%d mk=%u/%u", int(e.kind), int(e.table_id),
            e.processed_match_keys, e.match_keys_total);
#endif
        if (e.kind == EventKind::TableEnd && e.table_id < 4) {
            table_ns_[e.table_id].store(e.elapsed, std::memory_order_relaxed);
        }
        if (e.kind == EventKind::AllocationEnd) {
            alloc_ns_.store(e.elapsed, std::memory_order_relaxed);
        }
        if (e.kind == EventKind::Note && e.note_id == NoteId::LayoutTotalBytesAllocated) {
            layout_bytes_.store(e.u64_0, std::memory_order_relaxed);
        }
        // Pausing holds the plot thread here, at its next progress event, until resumed or
        // cancelled. Worker threads finish their current tasks and then sit idle.
        while (pause_.load(std::memory_order_relaxed) && !cancel_.load(std::memory_order_relaxed)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        return !cancel_.load(std::memory_order_relaxed);
    }

    AtomicProgressSnapshot snapshot() const noexcept { return inner_.snapshot(); }

    std::atomic<bool> cancel_ { false };
    std::atomic<bool> pause_ { false };
    std::atomic<uint64_t> table_ns_[4] {};
    std::atomic<uint64_t> alloc_ns_ { 0 };
    std::atomic<uint64_t> layout_bytes_ { 0 };

private:
    AtomicProgressSink inner_;
};

struct Job {
    std::unique_ptr<ProofParams> params;
    uint16_t index = 0;
    uint8_t meta_group = 0;
    std::vector<uint8_t> memo;

    Sink sink;
    std::atomic<int32_t> status { kIdle };
    std::string error;
    std::thread worker;

    PlotData plot;
    ChunkedProofFragments chunked;
    size_t next_chunk = 0;
    uint64_t file_pos = 0;
    std::vector<uint64_t> offsets;
    std::vector<uint8_t> chunk_buf;
    std::vector<uint8_t> header;
};

Job* g_job = nullptr;

void put(std::vector<uint8_t>& out, void const* p, size_t n)
{
    auto const* b = static_cast<uint8_t const*>(p);
    out.insert(out.end(), b, b + n);
}

// Builds the header exactly as PlotFile::writeData lays it out.
std::vector<uint8_t> build_header(Job const& j, std::vector<uint64_t> const& offsets)
{
    std::vector<uint8_t> h;
    put(h, "pos2", 4);
    uint8_t const version = PlotFile::FORMAT_VERSION;
    put(h, &version, 1);
    put(h, j.params->get_plot_id_bytes(), 32);
    uint8_t const k = static_cast<uint8_t>(j.params->get_k());
    uint8_t const match_key_bits = static_cast<uint8_t>(j.params->get_match_key_bits());
    put(h, &k, 1);
    put(h, &match_key_bits, 1);
    put(h, &j.index, 2);
    put(h, &j.meta_group, 1);
    uint8_t const memo_size = static_cast<uint8_t>(j.memo.size());
    put(h, &memo_size, 1);
    put(h, j.memo.data(), j.memo.size());
    uint64_t const num_chunks = offsets.size();
    put(h, &num_chunks, 8);
    for (uint64_t off: offsets) {
        put(h, &off, 8);
    }
    return h;
}

void join_worker()
{
    if (g_job && g_job->worker.joinable()) {
        g_job->worker.join();
    }
}

} // namespace

// Starts a plot on a background thread. Returns 0 on success.
// plot_id must point to 32 bytes. memo must point to memo_len bytes.
POS2W_EXPORT int32_t pos2w_start(uint8_t const* plot_id,
    int32_t k,
    int32_t strength,
    int32_t index,
    int32_t meta_group,
    uint8_t const* memo,
    int32_t memo_len,
    int32_t testnet)
{
    if (g_job && (g_job->status == kRunning)) {
        return -1;
    }
    if ((k & 1) != 0 || k < 18 || k > 32 || strength < 2 || strength > 255) {
        return -2;
    }
    if (index < 0 || index > 65535 || meta_group < 0 || meta_group > 255) {
        return -3;
    }
    // k28 needs an 8.7 GB working buffer. With 32 bit pointers that size wraps around and
    // the plotter would write out of bounds, so only 64 bit builds may plot above k26.
    if (sizeof(void*) < 8 && k > 26) {
        return -5;
    }
    if (plot_id == nullptr || memo == nullptr || memo_len <= 0 || memo_len > 255) {
        return -4;
    }
    join_worker();
    delete g_job;
    // Start the task pool here, on the calling thread. In Emscripten, creating pthreads from
    // another pthread stalls, so the plot thread must never be the one to start the pool.
    pos2w::TaskPool::instance().threads();
    pos2w::reset_phases();
    g_job = new Job();
    Job& j = *g_job;
    j.params = std::make_unique<ProofParams>(plot_id, k, strength, static_cast<uint8_t>(testnet));
    j.index = static_cast<uint16_t>(index);
    j.meta_group = static_cast<uint8_t>(meta_group);
    j.memo.assign(memo, memo + memo_len);
    j.status = kRunning;

    j.worker = std::thread([&j]() {
        try {
            Plotter plotter(*j.params);
            Plotter::Options opt;
            opt.sink = &j.sink;
            j.plot = plotter.run(opt);
            if (j.sink.cancel_) {
                j.plot = PlotData {};
                j.status = kCancelled;
            }
            else {
                j.status = kPlotted;
            }
        }
        catch (std::exception const& e) {
            j.error = e.what();
            j.status = kError;
        }
        catch (...) {
            j.error = "unknown error";
            j.status = kError;
        }
    });
    return 0;
}

POS2W_EXPORT int32_t pos2w_status() { return g_job ? g_job->status.load() : kIdle; }

POS2W_EXPORT double pos2w_progress() { return g_job ? g_job->sink.snapshot().fraction : 0.0; }

POS2W_EXPORT int32_t pos2w_phase()
{
    return g_job ? static_cast<int32_t>(g_job->sink.snapshot().state) : 0;
}

POS2W_EXPORT int32_t pos2w_table() { return g_job ? g_job->sink.snapshot().table_id : 0; }

// Milliseconds spent in table t (0 is Xs, 1..3 are tables), or allocation when t is 4.
POS2W_EXPORT double pos2w_timing_ms(int32_t t)
{
    if (!g_job)
        return 0;
    if (t == 4)
        return g_job->sink.alloc_ns_.load() / 1e6;
    if (t < 0 || t > 3)
        return 0;
    return g_job->sink.table_ns_[t].load() / 1e6;
}

POS2W_EXPORT double pos2w_layout_bytes() { return g_job ? double(g_job->sink.layout_bytes_) : 0; }

POS2W_EXPORT char const* pos2w_error() { return g_job ? g_job->error.c_str() : ""; }

POS2W_EXPORT void pos2w_cancel()
{
    if (g_job)
        g_job->sink.cancel_ = true;
}

// Pauses (1) or resumes (0) the running plot at its next progress event.
POS2W_EXPORT void pos2w_pause(int32_t on)
{
    if (g_job)
        g_job->sink.pause_ = on != 0;
}

// Splits the plot into chunks and returns the header size in bytes, or a negative error.
POS2W_EXPORT double pos2w_begin_write()
{
    if (!g_job || g_job->status != kPlotted)
        return -1;
    Job& j = *g_job;
    join_worker();
    try {
        uint64_t const range_per_chunk
            = (1ULL << (j.params->get_k() + PlotFile::CHUNK_SPAN_RANGE_BITS));
        j.chunked = ChunkedProofFragments::convertToChunkedProofFragments(j.plot, range_per_chunk);
        j.plot = PlotData {};
        j.offsets.assign(j.chunked.proof_fragments_chunks.size(), 0);
        j.next_chunk = 0;
        j.header = build_header(j, j.offsets);
        j.file_pos = j.header.size();
        j.status = kWriting;
        return double(j.header.size());
    }
    catch (std::exception const& e) {
        j.error = e.what();
        j.status = kError;
        return -2;
    }
}

POS2W_EXPORT double pos2w_num_chunks()
{
    return g_job ? double(g_job->chunked.proof_fragments_chunks.size()) : 0;
}

// Compresses the next chunk. Returns a pointer to its bytes, or null when no chunks remain.
// The length is available from pos2w_chunk_len(). The buffer is valid until the next call.
POS2W_EXPORT uint8_t const* pos2w_next_chunk()
{
    if (!g_job || g_job->status != kWriting)
        return nullptr;
    Job& j = *g_job;
    auto& chunks = j.chunked.proof_fragments_chunks;
    if (j.next_chunk >= chunks.size())
        return nullptr;
    try {
        size_t const i = j.next_chunk++;
        int const stub_bits = j.params->get_k() - PlotFile::MINUS_STUB_BITS;
        uint64_t const range_per_chunk
            = (1ULL << (j.params->get_k() + PlotFile::CHUNK_SPAN_RANGE_BITS));
        std::vector<uint8_t> compressed = ChunkCompressor::compressProofFragments(
            chunks[i], i * range_per_chunk, stub_bits);
        // Release this chunk's fragments now that they are compressed.
        std::vector<ProofFragment>().swap(chunks[i]);

        // writeVector prefixes the bytes with a uint64 length.
        j.chunk_buf.clear();
        uint64_t const n = compressed.size();
        put(j.chunk_buf, &n, 8);
        put(j.chunk_buf, compressed.data(), compressed.size());

        j.offsets[i] = j.file_pos;
        j.file_pos += j.chunk_buf.size();
        if (j.next_chunk == chunks.size()) {
            j.header = build_header(j, j.offsets);
        }
        return j.chunk_buf.data();
    }
    catch (std::exception const& e) {
        j.error = e.what();
        j.status = kError;
        return nullptr;
    }
}

POS2W_EXPORT double pos2w_chunk_len() { return g_job ? double(g_job->chunk_buf.size()) : 0; }

// Returns the final header. Call after the last chunk. Length is pos2w_header_len().
POS2W_EXPORT uint8_t const* pos2w_header()
{
    if (!g_job)
        return nullptr;
    g_job->status = kDone;
    return g_job->header.data();
}

POS2W_EXPORT double pos2w_header_len() { return g_job ? double(g_job->header.size()) : 0; }

POS2W_EXPORT double pos2w_file_size() { return g_job ? double(g_job->file_pos) : 0; }

// Frees all memory held by the last job.
POS2W_EXPORT void pos2w_reset()
{
    join_worker();
    delete g_job;
    g_job = nullptr;
}

POS2W_EXPORT int32_t pos2w_hardware_threads()
{
    return static_cast<int32_t>(std::thread::hardware_concurrency());
}

POS2W_EXPORT int32_t pos2w_has_aes() { return HAVE_AES; }

// Sets how many threads plot. Call before pos2w_start. Zero means hardware concurrency.
POS2W_EXPORT void pos2w_set_threads(int32_t n)
{
    if (n <= 0)
        n = static_cast<int32_t>(std::thread::hardware_concurrency());
    pos2w::TaskPool::instance().set_threads(static_cast<unsigned>(n < 1 ? 1 : n));
}

POS2W_EXPORT int32_t pos2w_threads() { return static_cast<int32_t>(pos2w::TaskPool::instance().threads()); }

#define EXPORT_FN POS2W_EXPORT
#define gpu_request_ptr pos2w_gpu_request_ptr
#define gpu_enable pos2w_gpu_enable
#define gpu_enabled pos2w_gpu_enabled
#define gpu_total_ms pos2w_gpu_total_ms
#define gpu_reset_total pos2w_gpu_reset_total
#define gpu_cpu_g pos2w_gpu_cpu_g
#include "gpu_exports.inc"

// Milliseconds the last plot spent in one phase of one table. table is 0 (Xs) to 3, phase is
// 0 hash, 1 sort, 2 find pairs, 3 post sort, 4 misc.
POS2W_EXPORT double pos2w_phase_ms(int32_t table, int32_t phase)
{
    if (table < 0 || table > 3 || phase < 0 || phase >= pos2w::kNumPhases)
        return 0;
    return pos2w::g_phase_ms[table][phase].load();
}
