# chia-plotter-wasm

A browser plotter for Chia Proof of Space v2 plot group files (`.gplot`). The pos2-chip
plotter is compiled to WebAssembly with threads, keys are derived in the browser with
`chia-bls`, and the finished plot is written straight into a folder you pick, or downloaded.

Status: alpha. k18 to k28 work in the browser. Everything here is built from public,
released code: pos2-chip 1.0.1, chia_rs 0.55 and chia-blockchain `main`. Plots are byte for
byte identical to `chia_rs.create_v2_single_plot_group`, which is what `chia plots create2`
calls.

## How v2 plots are made today

`chia plots create2` (merged in
[chia-blockchain#21430](https://github.com/Chia-Network/chia-blockchain/pull/21430), plot
groups in [#21566](https://github.com/Chia-Network/chia-blockchain/pull/21566)) calls
`create_v2_plots()` in `chia/plotting/create_plots.py`, which calls
`chia_rs.create_v2_single_plot_group`. chia-blockchain `main` pins `chia_rs >=0.55,<0.56`,
and chia_rs 0.55 uses `chia-pos2 1.0.1`, which is
[pos2-chip](https://github.com/Chia-Network/pos2-chip) tag `1.0.1`, pinned here as
`third_party/pos2-chip`.

`chia plots create2` options:

| Option | Meaning |
| --- | --- |
| `-k, --size` | Even k from 18 to 28. Defaults to the network's `PLOT_SIZE_V2`. k28 is required for farming on mainnet and current testnets. |
| `-s, --strength` | Plot strength, default 2. Must be within `MIN_PLOT_STRENGTH`..`MAX_PLOT_STRENGTH` (2..17). Higher strength makes the plot pass the filter less often. |
| `-n, --num` | Number of plot groups |
| `--plots-per-group` | Plots per group, default 1 (see Plot groups below) |
| `-f, --farmer_public_key` | Farmer public key (hex) |
| `-c, --pool_contract_address` | Pool contract address (plot NFT). Mutually exclusive with `-p`. |
| `-p, --pool_public_key` | Pool public key (solo, OG plots) |
| `-a, --alt_fingerprint` | Use keys from the local keychain instead of `-f`/`-p`/`-c` |
| `-d, --final_dir` | Output directory |
| `-x, --exclude_final_dir` | Do not add the directory to the harvester config |

Not selectable: the meta group is 0. pos2-chip 1.0 removed the testnet hashing constant, so
a plot is the same on every network.

What goes into a plot (mirrored in `keys/src/lib.rs`, checked against the Python):

1. `sk = AugSchemeMPL.key_gen(random 32 bytes)`, the plot master secret key.
2. `local_pk = master_sk_to_local_sk(sk).get_g1()` (path m/12381/8444/3/0).
3. `plot_pk = local_pk + farmer_pk + taproot_pk`. Every v2 plot has the taproot key, from
   `key_gen(sha256(local_pk + farmer_pk || farmer_pk))` (the v1 taproot message also
   includes `local_pk`).
4. `plot_group_id = sha256(strength || plot_pk || pool_pk_or_contract_ph)` and, for each
   plot in the group, `plot_id = sha256(plot_group_id || plot_index_be16 || meta_group)`.
5. `memo = pool_pk_or_contract_ph || farmer_pk || sk`, stored in the file header.
6. File name `plot-k{k}-{plot_group_id}.gplot`.

The file (`PlotGroupFile` in `src/plot/PlotFile.hpp`) is a 51 byte header ("PoS2", format
version 2, group ID, k, strength, group size, meta group, offset of the chunk index, memo
length), the memo, the compressed proof fragment chunks, then the chunk index. The plotter
derives the plot ID from the group ID, plot index and meta group.

### Plot groups

The format can hold many plots per file, and pos2-chip's prover and chia_rs read such
files, but nothing public writes them yet: pos2-chip only has `create_single_plot_group`,
which always writes a group of one, and `create2 --plots-per-group` warns that multiple plots per file
are not supported yet and writes each plot to its own `-{index}` file. The header has no
plot index, so the prover reads every one of those files as plot index 0, and a plot made
at any other index does not farm (checked with chia_rs: 0 of 40 proofs of an index 3 file
validate).

So this page only makes groups of one plot at index 0. The grouping modes (hard drive
layout, staggered and independent groups, adding to a group) stay on the page, disabled,
until upstream can write multi-plot group files. A writer here would have to plot each
member to disk first and merge them chunk by chunk at the end: a group of k28 plots does
not fit in a tab's memory.

Plotting is fully in memory. Times on an M4 Pro (14 cores, 24 GB), same plot group ID and
memo, all outputs byte identical (`tools/bench.sh`):

| k | file | peak RAM | `chia_rs` (create2) | native glue | WASM in Node |
| --- | --- | --- | --- | --- | --- |
| 20 | 2.9 MB | 75 MB | 0.8 s | 0.8 s | 3.7 s |
| 22 | 12 MB | 0.26 GB | 1.8 s | 1.6 s | 10.1 s |
| 24 | 53 MB | 1.0 GB | 8.9 s | 6.1 s | 32.0 s |
| 26 | 230 MB | 2.2 GB | 29.4 s | 26.0 s | 87.9 s |
| 28 | 1.0 GB | 8.7 GB | 165 s | 111 s | over 30 min |

The memory64 WASM build also produces the identical k28 file in Node, but slowly: Node
pages and compresses the 11 GB heap on this machine.

In the browser, measured with the previous pos2-chip 0.6.0 format, whose plotting work is
the same: k22 2.2 s on the CPU and 0.7 s with WebGPU, k26 31 s and 4.8 s, k28 2 min 10 s
(10.9 GB heap) and 41 s. With 1.0.1 a k20 plot with WebGPU takes about 0.5 s. At strength 6,
k22 took 22 s on the CPU and 2.9 s with WebGPU.

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
identical either way (checked against `chia_rs.create_v2_single_plot_group`).

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

- `third_party/pos2-chip` pos2-chip at tag 1.0.1 (git submodule).
- `core/` C API around the plotter (`src/pos2w.cpp`), built with Emscripten as
  `pos2w32` (wasm32, up to k26) and `pos2w64` (memory64, for k28), and natively as
  `pos2w_cli` for testing. `overrides/common/thread.hpp` replaces the plotter's
  thread-per-task pattern with a persistent pool, because creating pthreads in WASM is slow
  and stalls when done from another pthread.
- `keys/` Rust crate for plot group ID, plot ID and memo derivation, compiled to WASM with wasm-pack.
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

Set up chia-blockchain `main` once (Python 3.14; some pinned dependencies have no 3.15
builds yet):

```sh
git clone https://github.com/Chia-Network/chia-blockchain vendor/chia-blockchain
cd vendor/chia-blockchain && python3.14 -m venv .venv && .venv/bin/pip install -e .
```

k28 plots: `chia plots check -g <dir>` (use a scratch `CHIA_ROOT`).

Any k: `chia plots check` rejects v2 plots whose k is not the network's `PLOT_SIZE_V2`, so
`tools/check_plot.py` runs the same chia_rs calls (`Prover.get_qualities_for_challenge`,
`solve_proof`, `validate_proof_v2`) with the plot's own k. Proof checks only show fewer proofs when a chunk is damaged, so
`--reference core/build-native/pos2w_cli` also regenerates the plot natively from its header
and requires identical bytes.

```sh
vendor/chia-blockchain/.venv/bin/python -I tools/check_plot.py -n 50 \
  --reference core/build-native/pos2w_cli ~/Downloads/plot-k22-*.gplot
```

In the browser: the page checks every new plot (setting "Check each new plot", default 10
challenges) and has a "Validate plots" section for existing files. Both use `core/pos2v`,
pos2-chip's group prover, solver and validator compiled to WASM, with the same steps as
chia-blockchain, including dropping duplicate quality chains. Its proof counts match
`tools/check_plot.py` exactly (`tools/node-validate.mjs` runs it in Node). It also
recomputes the plot group ID from the keys in the memo, checks the file name, and compares
the farmer key with your settings. Like `chia plots check`, a damaged chunk can still pass
with fewer proofs, so the byte comparison above remains the strongest test.

Plots made by the WASM build (Node and browser) have been checked to be byte identical to
`chia_rs.create_v2_single_plot_group` given the same plot group ID and memo.
