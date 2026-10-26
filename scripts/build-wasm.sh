#!/usr/bin/env bash
# Builds the WASM plotter core (wasm32 and memory64 variants) and the key derivation
# package, and copies the outputs into the web app.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

git submodule update --init third_party/pos2-chip

for variant in 32 64; do
  flag=OFF; [[ $variant == 64 ]] && flag=ON
  emcmake cmake -S core -B core/build-wasm$variant -DCMAKE_BUILD_TYPE=Release -DPOS2W_MEMORY64=$flag >/dev/null
  cmake --build core/build-wasm$variant -j
done

mkdir -p web/public/wasm
cp core/build-wasm32/pos2w32.{js,wasm} core/build-wasm32/pos2v.{js,wasm} core/build-wasm64/pos2w64.{js,wasm} web/public/wasm/

# blst needs a clang that can target wasm32. Homebrew's llvm works on macOS.
llvm_bin="${LLVM_BIN:-$(brew --prefix llvm 2>/dev/null)/bin}"
(cd keys && CC_wasm32_unknown_unknown="$llvm_bin/clang" AR_wasm32_unknown_unknown="$llvm_bin/llvm-ar" \
  wasm-pack build --release --target web --out-dir ../web/src/lib/keys-pkg)
rm -f web/src/lib/keys-pkg/.gitignore
