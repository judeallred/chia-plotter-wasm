# chia-plotter-wasm

A browser plotter for Chia Proof of Space v2 (`.plot2`) plots. The pos2-chip plotter is
compiled to WebAssembly with threads, keys are derived in the browser with `chia-bls`, and
the finished plot is written straight into a folder you pick, or downloaded.

Status: alpha. k18 to k28 work in the browser. A k28 plot made in Chrome passes
`chia plots check` from the PR and is byte for byte identical to the native plotter.

## How v2 plots are made today

Source: [chia-blockchain#21430](https://github.com/Chia-Network/chia-blockchain/pull/21430)
adds `chia plots create2`. It calls `create_v2_plots()` in `chia/plotting/create_plots.py`,
which calls `chia_rs.create_v2_plot`. The PR pins `chia_rs >=0.49,<0.50`, and chia_rs 0.49
uses `chia-pos2 0.6.0`, which is [pos2-chip](https://github.com/Chia-Network/pos2-chip) tag
`0.6.0`. pos2-chip `main` (1.0.0) has moved on to a "plot group" format that this checker
does not read, so this repo pins pos2-chip at `0.6.0` (`third_party/pos2-chip`).

`chia plots create2` options:

| Option | Meaning |
| --- | --- |
| `-s, --strength` | Plot strength, default 2. Must be within `MIN_PLOT_STRENGTH`..`MAX_PLOT_STRENGTH` (2..17). Higher strength makes the plot pass the filter less often. |
| `-n, --num` | Number of plots |
| `-f, --farmer_public_key` | Farmer public key (hex) |
| `-c, --pool_contract_address` | Pool contract address (plot NFT). Mutually exclusive with `-p`. |
| `-p, --pool_public_key` | Pool public key (solo, OG plots) |
| `-a, --alt_fingerprint` | Use keys from the local keychain instead of `-f`/`-p`/`-c` |
| `-d, --final_dir` | Output directory |
| `-x, --exclude_final_dir` | Do not add the directory to the harvester config |

Not selectable: the size is the network constant `PLOT_SIZE_V2` (28 on mainnet and
testnet11), plot index and meta group are 0, and `TESTNET` comes from the selected network
(it changes a hashing constant, so testnet plots differ from mainnet plots).

What goes into a plot (mirrored in `keys/src/lib.rs`, checked against the Python):

1. `sk = AugSchemeMPL.key_gen(random 32 bytes)`, the plot master secret key.
2. `local_pk = master_sk_to_local_sk(sk).get_g1()` (path m/12381/8444/3/0).
3. `plot_pk = local_pk + farmer_pk`, plus a taproot key when using a pool contract.
4. `plot_group_id = sha256(strength || plot_pk || pool_pk_or_contract_ph)` and
   `plot_id = sha256(plot_group_id || plot_index_be16 || meta_group)`.
5. `memo = pool_pk_or_contract_ph || farmer_pk || sk`, stored in the plot header.
6. File name `plot-k{k}-{plot_id}.plot2`.

Plotting is fully in memory. Times on an M4 Pro (14 cores, 24 GB), same plot ID and memo,
all outputs byte identical (`tools/bench.sh`, browser numbers from the page):

| k | file | peak RAM | `chia_rs` (create2) | native glue | WASM in Node | WASM in Chrome | Chrome with WebGPU |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 20 | 3 MB | 75 MB | 0.9 s | 0.5 s | 1.0 s | | 0.3 s |
| 22 | 12 MB | 0.26 GB | 1.1 s | 1.4 s | 2.5 s | 2.2 s | 0.7 s |
| 24 | 53 MB | 1.0 GB | 8.0 s | 7.9 s | 7.9 s | about 8 s | about 2 s |
| 26 | 230 MB | 2.2 GB | 56 s | 52 s | 180 s | 31 s | 4.8 s |
| 28 | 989 MB | 8.7 GB (13 GB footprint) | 73 s | 78 s | | 2 min 10 s, 10.9 GB heap | 41 s |

At strength 6, k22 takes 22 s on the CPU and 2.9 s with WebGPU.

Caveats: this machine was swapping during these runs (a Docker VM was holding about 16 GB),
which hurts the k26 native and Node numbers. Chrome kept its memory resident and was fastest
at k26. The native k28 `create2` run was done earlier with less pressure.

Profiling (macOS `sample` on native k24) shows the plotter's threads idle about two thirds of
the time: it forks and joins all threads for every match key, so serial sections and load
imbalance dominate. Hashing is not the bottleneck: building natively without hardware AES
(the code path WASM uses) gives the same time.

k28 in the browser uses the memory64 build. The plotter's working buffer is 8.7 GB, and
the final proof fragments need about 2 GB more. Upstream `Plotter::run` copies that vector
instead of moving it, which pushed the browser heap to 13 GB. `core/CMakeLists.txt`
generates a copy of `Plotter.hpp` with `std::move`, which brings the peak to 10.9 GB. WASM
memory never shrinks, so the page drops the plotter worker when it goes idle.

## WebGPU

WGSL is the only GPU language browsers run (no CUDA, OpenCL or SPIR-V), and the work here is
integer AES, which WGSL handles fine. What runs on the GPU (`web/src/lib/gpu/`, requests
from C++ through `core/src/gpu_bridge.hpp`):

- Xs: `g(x)` for every x.
- Table pairs, per section (`core/src/table_gpu.hpp` hooks upstream's
  `TableConstructorGeneric`): a bucket directory over the right side, then
  `find_candidates` (matching target hash, directory lookup) writes (left, right) index
  pairs, and `pair_test`, launched with an indirect dispatch, runs one pairing hash per
  candidate and writes the table's output struct (T1Pairing, T2Pairing, or the Feistel
  encoded proof fragment). Splitting the passes matters: each left entry has a varying
  number of matches, and in one kernel every SIMD group waits for its unluckiest lane.
- Validation: the solver's all-x `g(x)` bitmask filter.

The CPU still does the radix sorts between tables and writes the file. Every plot starts
with a self test against the CPU, any failure falls back to the CPU, and output is byte
identical either way (checked against `chia_rs.create_v2_plot` at k20 to k28).

Measured on an M4 Pro: the T-table AES does about 790 M `g(x)` per second with a single
1 KB table and workgroups of 32 (630 M with four tables and 256). The pair kernels run
close to that rate, so the GPU side is AES bound. At k28 memory is the constraint: the
plotter heap is about 11 GB, so GPU uploads go in 256 MB pieces and GPU mode writes pairs
straight into the plotter's output instead of holding them. Before that, k28 swapped and
took 1 min 49 s.

The hybrid mode (CPU and GPU split each section, rebalanced after every section) works
but is slower than the GPU alone on Apple silicon: with both busy, each side ran at about
half speed (shared memory bandwidth and power). It may help with a discrete GPU.

Validating k28 in the browser was slow on the CPU (about 90 s for 30 challenges, versus 5
s for chia_rs), almost all in the solver's `g(x)` pass, which now runs on the GPU.

## Layout

- `third_party/pos2-chip` pos2-chip at tag 0.6.0 (git submodule).
- `core/` C API around the plotter (`src/pos2w.cpp`), built with Emscripten as
  `pos2w32` (wasm32, up to k26) and `pos2w64` (memory64, for k28), and natively as
  `pos2w_cli` for testing. `overrides/common/thread.hpp` replaces the plotter's
  thread-per-task pattern with a persistent pool, because creating pthreads in WASM is slow
  and stalls when done from another pthread.
- `keys/` Rust crate for plot ID and memo derivation, compiled to WASM with wasm-pack.
- `web/` Astro site styled with Tailwind CSS v4 (`src/styles/app.css` holds the theme tokens and a small components layer). The plotter runs in a Web Worker and streams the file to disk. `src/lib/app.ts` wires together the modules next to it (settings, estimates, existing plots, plan, history, validate UI), and `src/lib/gpu/` holds the WebGPU kernels, device, self test and request service.
- `tools/` checker and test scripts.

### Why the glue is C++ and the key code is Rust

New code we own is written in Rust where it can be. The C++ in `core/` is the exception,
for two reasons:

- It is glue that lives inside pos2-chip's C++: `table_gpu.hpp` and `thread.hpp` are
  templates injected into upstream classes and headers, and `pos2w.cpp` and `pos2v.cpp`
  call upstream templates (`Plotter`, `PlotFile`, `Prover`, `Solver`) directly. Rust would
  need a C++ shim for each of those, which is the same code again behind another boundary.
- k28 needs the memory64 build, and Rust has no 64 bit Emscripten target that can link into
  an Emscripten pthreads module.

The C++ follows pos2-chip's `.clang-format` (copied to `core/.clang-format`).

### Rust checks

`keys/` builds with rustfmt and clippy at their strictest: all, pedantic, nursery and cargo
lint groups plus restriction lints against panics, indexing and lossy casts, configured in
`keys/Cargo.toml`. `scripts/check-rust.sh` runs `cargo fmt --check`, clippy with
`-D warnings` natively and for `wasm32-unknown-unknown`, and the tests, whose vectors come
from chia-blockchain's own functions. Enable the pre-commit hook that runs it with
`git config core.hooksPath .githooks`. VS Code formats on save and shows clippy through
`.vscode/settings.json`.

## Build and run

Requirements: Emscripten, CMake, Rust with `wasm32-unknown-unknown`, wasm-pack, an LLVM
clang that can target wasm32 (`brew install llvm`), Node, pnpm.

```sh
git submodule update --init
./scripts/build-wasm.sh          # builds core + keys, copies into web/
cd web && pnpm install && pnpm dev
```

The page must be served with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (configured for dev, preview, and in
`public/_headers` for static hosts). Saving into a folder needs the File System Access API
(Chrome, Edge). Other browsers write to browser storage and download.

## Verifying plots

Set up the PR build of chia-blockchain once:

```sh
git clone https://github.com/Chia-Network/chia-blockchain vendor/chia-blockchain
cd vendor/chia-blockchain && git fetch origin pull/21430/head:pr-21430 && git checkout pr-21430
python3 -m venv .venv && .venv/bin/pip install -e .
```

k28 plots: `chia plots check -g <dir>` (use a scratch `CHIA_ROOT`).

Any k: `chia plots check` always solves with k=28, so `tools/check_plot.py` runs the same
chia_rs calls (`get_qualities_for_challenge`, `solve_proof`, `validate_proof_v2`) with the
plot's own k. Proof checks only show fewer proofs when a chunk is damaged, so
`--reference core/build-native/pos2w_cli` also regenerates the plot natively from its header
and requires identical bytes.

```sh
vendor/chia-blockchain/.venv/bin/python -I tools/check_plot.py -n 50 \
  --reference core/build-native/pos2w_cli ~/Downloads/plot-k22-*.plot2
```

In the browser: the page checks every new plot (setting "Check each new plot", default 10
challenges) and has a "Validate plots" section for existing files. Both use `core/pos2v`,
pos2-chip's prover, solver and validator compiled to WASM, with the same steps and the same
cap of 10 qualities per challenge as chia_rs. Its proof counts match `tools/check_plot.py`
exactly (`tools/node-validate.mjs` runs it in Node). It also recomputes the plot ID from the
keys in the memo, checks the file name, and compares the farmer key with your settings.
Testnet plots are detected automatically. Like `chia plots check`, a damaged chunk can still
pass with fewer proofs, so the byte comparison above remains the strongest test.

Plots made by the WASM build (Node and browser) have been checked to be byte identical to
`chia_rs.create_v2_plot` given the same plot ID and memo.
