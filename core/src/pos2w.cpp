// pos2w: a small C API around the pos2-chip 1.0.1 plotter, built for WebAssembly.
//
// The plot runs on a background thread so the caller (a Web Worker) stays free to poll
// progress. When plotting finishes, the caller pulls the plot group file out piece by piece:
//
//   1. pos2w_begin_write() chunks the proof fragments and returns the header size.
//   2. pos2w_next_piece() returns the file body one piece at a time: each compressed chunk
//      in order, then the chunk index.
//   3. pos2w_header() returns the final header, which records where the chunk index starts.
//
// The caller writes header_size placeholder bytes, then every piece in order, then
// overwrites the start of the file with the header. The resulting bytes are identical to
// PlotGroupFile::writeData from pos2-chip, which is what chia_rs.create_v2_single_plot_group
// writes and what chia_rs.Prover reads.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "common/thread.hpp"
#include "gpu_bridge.hpp"
#include "phase_timings.hpp"
#include "plot/PlotData.hpp"
#include "plot/PlotFile.hpp"
#include "plot/Plotter.hpp"
#include "plot/Progress.hpp"
#include "pos/ProofParams.hpp"
#include "pos/sha/sha256.hpp"

#if defined(__EMSCRIPTEN__)
#include <emscripten/console.h>
#include <emscripten/emscripten.h>
#define POS2W_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define POS2W_EXPORT extern "C"
#endif

namespace pos2w {

// Writes a plot group file of one plot in pieces, byte for byte as PlotGroupFile::writeData
// does. PlotGroupFile names this struct a friend (see core/CMakeLists.txt) so it can use the
// same private FSE table and chunk range helpers.
struct GroupWriter {
    using File = PlotGroupFile;

    GroupWriter() = default;
    GroupWriter(GroupWriter const&) = delete;
    GroupWriter& operator=(GroupWriter const&) = delete;
    ~GroupWriter()
    {
        if (ct_) {
            POS2_FSE_freeCTable(ct_);
        }
    }

    // Chunks the plot and builds the header with a placeholder chunk index offset.
    void begin(PlotData& plot, PlotGroupParams const& group, std::span<uint8_t const> memo)
    {
        auto const k = static_cast<uint8_t>(group.get_k());
        range_per_chunk_ = File::getRangePerChunkForK(k);
        chunked_ = ChunkedProofFragments::convertToChunkedProofFragments(plot, range_per_chunk_);
        plot = PlotData {};
        std::size_t const chunk_count = chunked_.proof_fragments_chunks.size();
        if (chunk_count != File::getChunkCountForK(k)) {
            throw std::runtime_error("Unexpected chunk count: " + std::to_string(chunk_count)
                + " != " + std::to_string(File::getChunkCountForK(k)));
        }
        header_ = File::Header {
            .magic = File::MAGIC,
            .version = File::FORMAT_VERSION,
            .group_id = group.get_plot_group_id(),
            .k = k,
            .strength = static_cast<uint8_t>(group.get_strength()),
            .group_size = 1,
            .meta_group = static_cast<uint8_t>(group.get_meta_group()),
            .chunk_index_offset = 0,
            .memo_length = static_cast<uint8_t>(memo.size()),
        };
        memo_.assign(memo.begin(), memo.end());
        offsets_.assign(chunk_count, 0);
        ans_buffer_.resize(std::size_t(1) << File::PROOFS_PER_CHUNK_BITS);
        ct_ = File::createFSECTable();
        next_ = 0;
        index_written_ = false;
        file_pos_ = header_bytes().size();
    }

    std::size_t num_chunks() const { return offsets_.size(); }

    // The next piece of the file after the header, or nullptr once the file is complete.
    std::vector<uint8_t> const* next()
    {
        piece_.clear();
        if (next_ < offsets_.size()) {
            std::size_t const i = next_++;
            encode_chunk(i);
            // Release this chunk's fragments now that they are compressed.
            std::vector<ProofFragment>().swap(chunked_.proof_fragments_chunks[i]);
            offsets_[i] = file_pos_;
        }
        else if (!index_written_) {
            encode_index();
            index_written_ = true;
        }
        else {
            return nullptr;
        }
        file_pos_ += piece_.size();
        return &piece_;
    }

    bool done() const { return index_written_; }

    // The header and memo, as they start the file.
    std::vector<uint8_t> header_bytes() const
    {
        std::vector<uint8_t> h(sizeof(header_) + memo_.size());
        std::memcpy(h.data(), &header_, sizeof(header_));
        std::memcpy(h.data() + sizeof(header_), memo_.data(), memo_.size());
        return h;
    }

private:
    // One chunk: the deltas between sorted, deduplicated fragments, split into a high byte
    // (FSE coded) and unary plus low bits. Mirrors the chunk loop of writeData.
    void encode_chunk(std::size_t chunk_index)
    {
        uint8_t const low_bits_count = header_.k - 8;
        uint64_t const threshold = (178ull << (header_.k - 8));
        uint64_t const low_mask = ((1ull << low_bits_count) - 1);

        std::vector<uint64_t>& deltas = deltas_;
        deltas = chunked_.proof_fragments_chunks[chunk_index];
        if (deltas.empty()) {
            throw std::runtime_error("empty plot chunk");
        }
        uint64_t const start = chunk_index * range_per_chunk_;
        uint64_t prev_value = deltas[0];
        deltas[0] = prev_value - start;
        std::size_t count = 1;
        for (std::size_t i = 1; i < deltas.size(); i++) {
            uint64_t const fragment = deltas[i];
            if (fragment == prev_value) {
                continue;
            }
            deltas[count++] = fragment - prev_value;
            prev_value = fragment;
        }
        deltas.resize(count);

        high_bytes_.resize(deltas.size());
        bits_.clear();
        for (std::size_t i = 0; i < deltas.size(); i++) {
            uint64_t const d = deltas[i];
            uint64_t const quotient = d / threshold;
            uint64_t const remainder = d - quotient * threshold;
            uint64_t const unary_value = (1ull << quotient) - 1;
            uint64_t const low_bits = remainder & low_mask;
            bits_.append((unary_value << low_bits_count) | low_bits,
                uint32_t(1 + quotient + low_bits_count));
            high_bytes_[i] = uint8_t(remainder >> low_bits_count);
        }

        std::size_t ans_size = 0;
        constexpr int kMaxRetries = 5;
        for (int retry = 0; retry < kMaxRetries; retry++) {
            ans_size = POS2_FSE_compress_usingCTable(ans_buffer_.data(),
                ans_buffer_.capacity(),
                high_bytes_.data(),
                high_bytes_.size(),
                ct_);
            bool const too_small = ans_size == 0
                || (POS2_FSE_isError(ans_size)
                    && -FSE_ErrorCode(ans_size) == FSE_error_dstSize_tooSmall);
            if (too_small) {
                if (retry + 1 < kMaxRetries) {
                    ans_buffer_.resize(ans_buffer_.capacity() * 2);
                    continue;
                }
                throw std::runtime_error("FSE_compress_usingCTable error");
            }
            if (POS2_FSE_isError(ans_size)) {
                throw std::runtime_error(std::string("FSE_compress_usingCTable error: ")
                    + POS2_FSE_getErrorName(ans_size));
            }
            if (ans_size > deltas.size()) {
                throw std::runtime_error("ANS is larger than raw bytes");
            }
            break;
        }

        // LEB128 length of the FSE part, then the FSE part, then the unary and low bits.
        uint64_t const bit_count = (sizeof(ans_size) * 8) - std::countl_zero(ans_size);
        uint64_t const leb_count = cdiv(bit_count, 7);
        for (std::size_t i = 0; i < leb_count; i++) {
            uint8_t byte = uint8_t((ans_size >> (i * 7)) & 0x7f);
            if (i + 1 < leb_count) {
                byte |= 0x80;
            }
            piece_.push_back(byte);
        }
        piece_.insert(piece_.end(), ans_buffer_.begin(), ans_buffer_.begin() + std::ptrdiff_t(ans_size));
        std::span<uint8_t const> const rest = bits_.asBytes();
        piece_.insert(piece_.end(), rest.begin(), rest.end());
    }

    // The chunk sizes, gsz coded, after the last chunk. The header points at them.
    void encode_index()
    {
        header_.chunk_index_offset = file_pos_;
        std::vector<uint64_t> sizes(offsets_.size());
        for (std::size_t i = 0; i + 1 < offsets_.size(); i++) {
            sizes[i] = offsets_[i + 1] - offsets_[i];
        }
        sizes.back() = file_pos_ - offsets_.back();
        BitWriter writer;
        writer.clear();
        gsz_encode(sizes, header_.group_size, writer);
        std::span<uint8_t const> const bytes = writer.asBytes();
        piece_.assign(bytes.begin(), bytes.end());
    }

    File::Header header_ {};
    std::vector<uint8_t> memo_;
    ChunkedProofFragments chunked_;
    uint64_t range_per_chunk_ = 0;
    std::vector<uint64_t> offsets_;
    std::size_t next_ = 0;
    bool index_written_ = false;
    uint64_t file_pos_ = 0;
    FSE_CTable* ct_ = nullptr;
    std::vector<uint8_t> ans_buffer_;
    std::vector<uint64_t> deltas_;
    std::vector<uint8_t> high_bytes_;
    BitWriter bits_;
    std::vector<uint8_t> piece_;
};

} // namespace pos2w

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
        emscripten_console_logf("event kind=%d table=%d mk=%u/%u",
            int(e.kind),
            int(e.table_id),
            e.processed_match_keys,
            e.match_keys_total);
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
        // A failed task stops the plot here. The job reports the task's error.
        return !cancel_.load(std::memory_order_relaxed) && !pos2w::TaskPool::instance().failed();
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
    std::unique_ptr<PlotGroupParams> group;
    std::unique_ptr<PlotProofParams> params;
    std::vector<uint8_t> memo;

    Sink sink;
    std::atomic<int32_t> status { kIdle };
    std::string error;
    std::thread worker;

    PlotData plot;
    pos2w::GroupWriter writer;
    std::vector<uint8_t> const* piece = nullptr;
    std::vector<uint8_t> header;
};

Job* g_job = nullptr;

void join_worker()
{
    if (g_job && g_job->worker.joinable()) {
        g_job->worker.join();
    }
}

} // namespace

// Starts a plot on a background thread. Returns 0 on success.
// plot_group_id must point to 32 bytes. memo must point to memo_len bytes. The plot ID is
// derived from the group ID, index and meta group, as PlotGroupParams does.
POS2W_EXPORT int32_t pos2w_start(uint8_t const* plot_group_id,
    int32_t k,
    int32_t strength,
    int32_t index,
    int32_t meta_group,
    uint8_t const* memo,
    int32_t memo_len)
{
    if (g_job && (g_job->status == kRunning)) {
        return -1;
    }
    if ((k & 1) != 0 || k < K_MIN || k > K_MAX || strength < STRENGTH_MIN || strength > STRENGTH_MAX) {
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
    if (plot_group_id == nullptr || memo == nullptr || memo_len <= 0 || memo_len > 255) {
        return -4;
    }
    // The params reject some combinations themselves (strength must be below k minus the
    // section bits minus 1). Check before touching the current job, and never let the
    // exception cross the C boundary.
    std::unique_ptr<PlotGroupParams> group;
    std::unique_ptr<PlotProofParams> params;
    try {
        group = std::make_unique<PlotGroupParams>(PlotGroupId(plot_group_id),
            static_cast<uint8_t>(k),
            static_cast<uint8_t>(strength),
            static_cast<uint8_t>(meta_group));
        params = std::make_unique<PlotProofParams>(
            group->get_plot_params_for_index(static_cast<uint16_t>(index)));
    }
    catch (std::exception const&) {
        return -2;
    }
    join_worker();
    delete g_job;
    // Start the task pool here, on the calling thread. In Emscripten, creating pthreads from
    // another pthread stalls, so the plot thread must never be the one to start the pool.
    pos2w::TaskPool& pool = pos2w::TaskPool::instance();
    pool.threads();
    pool.take_error();
    pos2w::reset_phases();
    g_job = new Job();
    Job& j = *g_job;
    j.group = std::move(group);
    j.params = std::move(params);
    j.memo.assign(memo, memo + memo_len);
    j.status = kRunning;

    j.worker = std::thread([&j, &pool]() {
        try {
            Plotter plotter(*j.params);
            Plotter::Options opt;
            opt.sink = &j.sink;
            j.plot = plotter.run(opt);
            if (std::exception_ptr task_error = pool.take_error()) {
                j.plot = PlotData {};
                std::rethrow_exception(task_error);
            }
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
        j.writer.begin(j.plot, *j.group, j.memo);
        j.header = j.writer.header_bytes();
        j.status = kWriting;
        return double(j.header.size());
    }
    catch (std::exception const& e) {
        j.error = e.what();
        j.status = kError;
        return -2;
    }
}

// Number of chunks in the file, for progress. pos2w_next_piece returns one more piece than
// this: the chunk index.
POS2W_EXPORT double pos2w_num_chunks() { return g_job ? double(g_job->writer.num_chunks()) : 0; }

// Returns a pointer to the next piece of the file after the header, or null when none remain
// (or on error, see pos2w_status). The length is pos2w_piece_len(). The buffer is valid until
// the next call.
POS2W_EXPORT uint8_t const* pos2w_next_piece()
{
    if (!g_job || g_job->status != kWriting)
        return nullptr;
    Job& j = *g_job;
    try {
        j.piece = j.writer.next();
        if (!j.piece)
            return nullptr;
        if (j.writer.done())
            j.header = j.writer.header_bytes();
        return j.piece->data();
    }
    catch (std::exception const& e) {
        j.piece = nullptr;
        j.error = e.what();
        j.status = kError;
        return nullptr;
    }
}

POS2W_EXPORT double pos2w_piece_len()
{
    return g_job && g_job->piece ? double(g_job->piece->size()) : 0;
}

// Returns the final header, or null unless every piece has been written. Length is
// pos2w_header_len().
POS2W_EXPORT uint8_t const* pos2w_header()
{
    if (!g_job || g_job->status != kWriting || !g_job->writer.done())
        return nullptr;
    g_job->status = kDone;
    return g_job->header.data();
}

POS2W_EXPORT double pos2w_header_len() { return g_job ? double(g_job->header.size()) : 0; }

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
// Ignored while a plot is running, whose tasks are on the pool.
POS2W_EXPORT void pos2w_set_threads(int32_t n)
{
    if (g_job && g_job->status == kRunning)
        return;
    if (n <= 0)
        n = static_cast<int32_t>(std::thread::hardware_concurrency());
    pos2w::TaskPool::instance().set_threads(static_cast<unsigned>(n < 1 ? 1 : n));
}

POS2W_EXPORT int32_t pos2w_threads()
{
    return static_cast<int32_t>(pos2w::TaskPool::instance().threads());
}

// GPU exports, named pos2w_gpu_*.
#define EXPORT_FN POS2W_EXPORT
#define GPU_PREFIX pos2w
#include "gpu_exports.inc"
#include "gpu_plot_exports.inc"

// Milliseconds the last plot spent in one phase of one table. table is 0 (Xs) to 3, phase is
// 0 hash, 1 sort, 2 find pairs, 3 post sort, 4 misc.
POS2W_EXPORT double pos2w_phase_ms(int32_t table, int32_t phase)
{
    if (table < 0 || table > 3 || phase < 0 || phase >= pos2w::kNumPhases)
        return 0;
    return pos2w::g_phase_ms[table][phase].load();
}
