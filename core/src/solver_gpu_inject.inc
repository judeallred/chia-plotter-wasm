// Inserted into Solver by core/CMakeLists.txt. The upstream function is renamed to
// filterX2Candidates_cpu and stays the fallback.
void filterX2Candidates(std::span<uint32_t const> const x1_bitmask,
    size_t num_x_pairs,
    std::vector<uint32_t>& x2_potential_match_xs,
    std::vector<uint32_t>& x2_potential_match_hashes)
{
    if (!filterX2CandidatesGpu(
            x1_bitmask, num_x_pairs, x2_potential_match_xs, x2_potential_match_hashes)) {
        filterX2Candidates_cpu(
            x1_bitmask, num_x_pairs, x2_potential_match_xs, x2_potential_match_hashes);
    }
}

// Produces exactly what filterX2Candidates_cpu produces, using the GPU for the g(x) and
// bitmask pass. Returns false, leaving the outputs untouched, if no GPU is available.
bool filterX2CandidatesGpu(std::span<uint32_t const> const x1_bitmask,
    size_t num_x_pairs,
    std::vector<uint32_t>& x2_potential_match_xs,
    std::vector<uint32_t>& x2_potential_match_hashes)
{
    if (!pos2w::gpu::g_enabled.load()) {
        return false;
    }
    // The sizing below is copied from filterX2Candidates_cpu so overflow behaves the same.
    int const num_k_bits = params_.get_k();
    uint64_t const NUM_XS = (1ULL << num_k_bits);
    unsigned num_threads = std::thread::hardware_concurrency();
    if (num_threads == 0)
        num_threads = 4;
    uint64_t const per_thread = NUM_XS / num_threads;
    uint64_t const chunk_size = per_thread - (per_thread % 16);
    int const x1_bits = num_k_bits / 2;
    int const x1_range_size = 1 << (num_k_bits - x1_bits);
    size_t const num_match_keys = params_.get_num_match_keys(1);
    size_t const num_match_target_hashes = num_x_pairs * x1_range_size * num_match_keys;
    double const hit_probability
        = double(num_match_target_hashes) / double(NUM_XS >> this->bitmask_shift_);
    uint64_t const max_candidates = NUM_XS - uint64_t(num_threads - 1) * chunk_size;
    size_t const MAX_RESULTS_PER_THREAD = x2CandidateCapacity(hit_probability, max_candidates);
    size_t const capacity = size_t(num_threads) * MAX_RESULTS_PER_THREAD;

    Timer timer;
    timer.start("GPU bitmask test");
    std::vector<uint32_t> pairs(2 * capacity);
    pos2w::gpu::Request req {};
    req.op = pos2w::gpu::kFilterBitmask;
    pos2w::gpu::fill_params(req, params_);
    req.bitmask_shift = static_cast<uint32_t>(this->bitmask_shift_);
    req.bitmask_words = static_cast<uint32_t>(x1_bitmask.size());
    req.bitmask_ptr = reinterpret_cast<uintptr_t>(x1_bitmask.data());
    req.out_ptr = reinterpret_cast<uintptr_t>(pairs.data());
    req.out_capacity = capacity;
    if (!pos2w::gpu::call(req)) {
        return false;
    }

    auto too_many = []() {
        return std::runtime_error(
            "Too many matches. This is unlikely to happen, so we won't be solving this");
    };
    if (req.result_count > capacity) {
        throw too_many();
    }
    size_t const n = static_cast<size_t>(req.result_count);

    // The CPU version emits matches in x order, one contiguous range per thread.
    std::vector<uint64_t> sorted(n);
    for (size_t i = 0; i < n; ++i) {
        sorted[i] = (uint64_t(pairs[2 * i]) << 32) | pairs[2 * i + 1];
    }
    std::sort(sorted.begin(), sorted.end());

    // A CPU thread gives up once it reaches MAX_RESULTS_PER_THREAD matches.
    std::vector<size_t> per_thread_count(num_threads, 0);
    for (uint64_t v: sorted) {
        uint64_t const x = v >> 32;
        size_t const t = std::min<uint64_t>(x / chunk_size, num_threads - 1);
        if (++per_thread_count[t] >= MAX_RESULTS_PER_THREAD) {
            throw too_many();
        }
    }

    x2_potential_match_xs.resize(n);
    x2_potential_match_hashes.resize(n);
    for (size_t i = 0; i < n; ++i) {
        x2_potential_match_xs[i] = uint32_t(sorted[i] >> 32);
        x2_potential_match_hashes[i] = uint32_t(sorted[i]);
    }
    timings_.chachafilterx2sbybitmask += timer.stop();
    return true;
}
