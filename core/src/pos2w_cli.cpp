// Native harness for the pos2w API. It plots using the same streaming calls the browser
// uses, writes the result, and optionally writes a reference file
// the way chia_rs.create_v2_single_plot_group does (PlotGroupFile::writeData), so the two
// can be compared byte for byte.
//
// Usage: pos2w_cli <out.gplot> <k> <strength> <plot_group_id_hex> <memo_hex> [index]
// [meta_group] [reference_out]

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <optional>
#include <string>
#include <thread>
#include <vector>

// pos2-chip headers define non-inline functions, so everything must be one translation unit.
#include "pos2w.cpp"

// Decodes hex, or returns nothing if s is not an even number of hex digits.
static std::optional<std::vector<uint8_t>> from_hex(std::string const& s)
{
    if (s.size() % 2 != 0 || s.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos)
        return std::nullopt;
    std::vector<uint8_t> out(s.size() / 2);
    for (size_t i = 0; i < out.size(); ++i)
        out[i] = static_cast<uint8_t>(std::stoul(s.substr(2 * i, 2), nullptr, 16));
    return out;
}

int main(int argc, char** argv)
{
    if (argc < 6) {
        std::cerr << "usage: " << argv[0]
                  << " <out> <k> <strength> <plot_group_id_hex> <memo_hex> [index] "
                     "[meta_group] [reference_out]\n";
        return 1;
    }
    std::string out_path = argv[1];
    int k = std::atoi(argv[2]);
    int strength = std::atoi(argv[3]);
    auto const group_id_bytes = from_hex(argv[4]);
    auto const memo_bytes = from_hex(argv[5]);
    if (!group_id_bytes || group_id_bytes->size() != 32) {
        std::cerr << "plot group ID must be 64 hex characters\n";
        return 1;
    }
    if (!memo_bytes || memo_bytes->empty()) {
        std::cerr << "memo must be hex\n";
        return 1;
    }
    std::vector<uint8_t> const& group_id = *group_id_bytes;
    std::vector<uint8_t> const& memo = *memo_bytes;
    int index = argc > 6 ? std::atoi(argv[6]) : 0;
    int meta_group = argc > 7 ? std::atoi(argv[7]) : 0;

    auto t0 = std::chrono::steady_clock::now();
    if (int rc = pos2w_start(
            group_id.data(), k, strength, index, meta_group, memo.data(), int(memo.size()))) {
        std::cerr << "start failed " << rc << "\n";
        return 1;
    }
    while (pos2w_status() == kRunning) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        std::fprintf(stderr, "\r%5.1f%%", pos2w_progress() * 100);
    }
    std::fprintf(stderr, "\n");
    if (pos2w_status() != kPlotted) {
        std::cerr << "plot failed: " << pos2w_error() << "\n";
        return 1;
    }
    auto t1 = std::chrono::steady_clock::now();

    std::ofstream out(out_path, std::ios::binary);
    size_t header_size = size_t(pos2w_begin_write());
    std::vector<char> zeros(header_size, 0);
    out.write(zeros.data(), zeros.size());
    while (uint8_t const* p = pos2w_next_piece())
        out.write(reinterpret_cast<char const*>(p), std::streamsize(pos2w_piece_len()));
    uint8_t const* header = pos2w_header();
    if (!header) {
        std::cerr << "write failed: " << pos2w_error() << "\n";
        return 1;
    }
    out.seekp(0);
    out.write(reinterpret_cast<char const*>(header), std::streamsize(pos2w_header_len()));
    out.close();
    auto t2 = std::chrono::steady_clock::now();

    auto ms
        = [](auto a, auto b) { return std::chrono::duration<double, std::milli>(b - a).count(); };
    std::printf("layout_bytes=%.0f plot_ms=%.0f write_ms=%.0f xs_ms=%.0f t1_ms=%.0f t2_ms=%.0f "
                "t3_ms=%.0f\n",
        pos2w_layout_bytes(),
        ms(t0, t1),
        ms(t1, t2),
        pos2w_timing_ms(0),
        pos2w_timing_ms(1),
        pos2w_timing_ms(2),
        pos2w_timing_ms(3));

    if (argc > 8) {
        // Reference path: what create_single_plot_group in pos2-chip's api.cpp does.
        PlotGroupParams const group(
            PlotGroupId(group_id.data()), uint8_t(k), uint8_t(strength), uint8_t(meta_group));
        Plotter plotter(group.get_plot_params_for_index(uint16_t(index)));
        PlotData plot = plotter.run();
        PlotGroupFile::writeData(argv[8],
            plot,
            group,
            PlotGroupFile::PROOFS_PER_CHUNK_BITS,
            std::span<uint8_t const>(memo));
    }
    return 0;
}
