#!/usr/bin/env bash
# Formatting and strict clippy for the Rust crate, natively and for the browser target.
# Lints are configured in keys/Cargo.toml. Pass --fix to format instead of checking.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../keys"

if [[ "${1:-}" == "--fix" ]]; then
  cargo fmt
else
  cargo fmt --check
fi
cargo clippy --all-targets -- -D warnings
# blst needs a clang that can target wasm32. Homebrew's llvm works on macOS.
llvm_bin="${LLVM_BIN:-$(brew --prefix llvm 2>/dev/null)/bin}"
CC_wasm32_unknown_unknown="$llvm_bin/clang" AR_wasm32_unknown_unknown="$llvm_bin/llvm-ar" \
  cargo clippy --target wasm32-unknown-unknown --lib -- -D warnings
cargo test --quiet
