// Native harness for the pos2w API. It plots using the same streaming calls the browser
// uses, writes the result, and optionally writes a reference file via PlotFile::writeData
// so the two can be compared byte for byte.
//
// Usage: pos2w_cli <out.plot2> <k> <strength> <plot_id_hex> <memo_hex> [testnet] [reference_out]

#include <chrono>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>


// pos2-chip headers define non-inline functions, so everything must be one translation unit.
#include "pos2w.cpp"

static std::vector<uint8_t> from_hex(std::string const& s)
{
    std::vector<uint8_t> out(s.size() / 2);
    for (size_t i = 0; i < out.size(); ++i)
        out[i] = static_cast<uint8_t>(std::stoul(s.substr(2 * i, 2), nullptr, 16));
    return out;
}

int main(int argc, char** argv)
{
    if (argc < 6) {
        std::cerr << "usage: " << argv[0]
                  << " <out> <k> <strength> <plot_id_hex> <memo_hex> [testnet] [reference_out]\n";
        return 1;
    }
    std::string out_path = argv[1];
    int k = std::atoi(argv[2]);
    int strength = std::atoi(argv[3]);
    auto plot_id = from_hex(argv[4]);
    auto memo = from_hex(argv[5]);
    int testnet = argc > 6 ? std::atoi(argv[6]) : 0;

    auto t0 = std::chrono::steady_clock::now();
    if (int rc = pos2w_start(plot_id.data(), k, strength, 0, 0, memo.data(), int(memo.size()), testnet)) {
        std::cerr << "start failed " << rc << "\n";
        return 1;
    }
    while (pos2w_status() == 1) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        std::fprintf(stderr, "\r%5.1f%%", pos2w_progress() * 100);
    }
    std::fprintf(stderr, "\n");
    if (pos2w_status() != 2) {
        std::cerr << "plot failed: " << pos2w_error() << "\n";
        return 1;
    }
    auto t1 = std::chrono::steady_clock::now();

    std::ofstream out(out_path, std::ios::binary);
    size_t header_size = size_t(pos2w_begin_write());
    std::vector<char> zeros(header_size, 0);
    out.write(zeros.data(), zeros.size());
    while (uint8_t const* p = pos2w_next_chunk())
        out.write(reinterpret_cast<char const*>(p), std::streamsize(pos2w_chunk_len()));
    out.seekp(0);
    out.write(reinterpret_cast<char const*>(pos2w_header()), std::streamsize(pos2w_header_len()));
    out.close();
    auto t2 = std::chrono::steady_clock::now();

    auto ms = [](auto a, auto b) { return std::chrono::duration<double, std::milli>(b - a).count(); };
    std::printf("plot_ms=%.0f write_ms=%.0f xs_ms=%.0f t1_ms=%.0f t2_ms=%.0f t3_ms=%.0f\n",
        ms(t0, t1), ms(t1, t2), pos2w_timing_ms(0), pos2w_timing_ms(1), pos2w_timing_ms(2),
        pos2w_timing_ms(3));

    if (argc > 7) {
        // Reference path: the plotter's own writer.
        ProofParams params(plot_id.data(), uint8_t(k), uint8_t(strength), uint8_t(testnet));
        Plotter plotter(params);
        PlotData plot = plotter.run();
        PlotFile::writeData(argv[7], plot, params, 0, 0, std::span<uint8_t const>(memo));
    }
    return 0;
}
