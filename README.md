# chia-plotter-wasm

A browser plotter for Chia Proof of Space v2 (`.plot2`) plots. The pos2-chip plotter is
compiled to WebAssembly with threads, keys are derived in the browser with `chia-bls`, and
the finished plot is written straight into a folder you pick, or downloaded.

Status: alpha. k18 to k26 work in the browser and produce plots that are byte for byte
identical to `chia plots create2`. k28, the size the network actually uses, is next.

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

| k | file | peak RAM | `chia_rs` (create2) | native glue | WASM in Node | WASM in Chrome |
| --- | --- | --- | --- | --- | --- | --- |
| 20 | 3 MB | 75 MB | 0.9 s | 0.5 s | 1.0 s | |
| 22 | 12 MB | 0.26 GB | 1.1 s | 1.4 s | 2.5 s | 2.2 s |
| 24 | 53 MB | 1.0 GB | 8.0 s | 7.9 s | 7.9 s | about 8 s |
| 26 | 230 MB | 2.2 GB | 56 s | 52 s | 180 s | 31 s |
| 28 | 989 MB | 8.7 GB | 73 s | | | |

Caveats: this machine was swapping during these runs (a Docker VM was holding about 16 GB),
which hurts the k26 native and Node numbers. Chrome kept its memory resident and was fastest
at k26. The native k28 `create2` run was done earlier with less pressure.

Profiling (macOS `sample` on native k24) shows the plotter's threads idle about two thirds of
the time: it forks and joins all threads for every match key, so serial sections and load
imbalance dominate. Hashing is not the bottleneck: building natively without hardware AES
(the code path WASM uses) gives the same time.

## Layout

- `third_party/pos2-chip` pos2-chip at tag 0.6.0 (git submodule).
- `core/` C API around the plotter (`src/pos2w.cpp`), built with Emscripten as
  `pos2w32` (wasm32, up to k26) and `pos2w64` (memory64, for k28), and natively as
  `pos2w_cli` for testing. `overrides/common/thread.hpp` replaces the plotter's
  thread-per-task pattern with a persistent pool, because creating pthreads in WASM is slow
  and stalls when done from another pthread.
- `keys/` Rust crate for plot ID and memo derivation, compiled to WASM with wasm-pack.
- `web/` Astro site. The plotter runs in a Web Worker and streams the file to disk.
- `tools/` checker and test scripts.

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
