#!/usr/bin/env bash
# Times the same plot (same plot group ID and memo) with three plotters:
#   chia_rs   chia_rs.create_v2_single_plot_group, what `chia plots create2` runs (native,
#             HW AES)
#   native    core/build-native/pos2w_cli (this repo's glue, native, HW AES)
#   wasm-node core/build-wasm32 under Node (same WASM the browser runs)
# and checks that all three files are identical.
# Usage: tools/bench.sh [k ...]   (default: 20 22 24 26)
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
py="$root/vendor/chia-blockchain/.venv/bin/python"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
group_id=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
memo=$(printf 'ab%.0s' $(seq 1 112))

now() { "$py" -c 'import time; print(time.monotonic())'; }
elapsed() { "$py" -c "print(f'{$2 - $1:.1f}')"; }

printf "%-4s %10s %10s %10s  %s\n" k chia_rs native wasm-node identical
for k in "${@:-20 22 24 26}"; do
  for k1 in $k; do
    t0=$(now)
    "$py" -I -c "import sys; from chia_rs import create_v2_single_plot_group; create_v2_single_plot_group(sys.argv[1], $k1, 2, bytes.fromhex('$group_id'), 0, 0, bytes.fromhex('$memo'))" "$tmp/a.gplot"
    t1=$(now)
    "$root/core/build-native/pos2w_cli" "$tmp/b.gplot" "$k1" 2 "$group_id" "$memo" >/dev/null 2>&1
    t2=$(now)
    node "$root/tools/node-plot.mjs" wasm32 "$k1" 2 "$group_id" "$memo" "$tmp/c.gplot" >/dev/null 2>&1
    t3=$(now)
    same=no
    cmp -s "$tmp/a.gplot" "$tmp/b.gplot" && cmp -s "$tmp/a.gplot" "$tmp/c.gplot" && same=yes
    printf "%-4s %9ss %9ss %9ss  %s\n" "$k1" "$(elapsed $t0 $t1)" "$(elapsed $t1 $t2)" "$(elapsed $t2 $t3)" "$same"
  done
done
