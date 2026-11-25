#!/usr/bin/env bash
# Builds the page for xch.nyc/plotter/ into deploy/, the tree wrangler.jsonc serves.
# Workers static assets can't mount a folder at a path prefix, so the build is nested
# under deploy/plotter/ to match the URL. The WASM is committed, so this needs only Node and pnpm.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/web"
pnpm install --frozen-lockfile
PLOTTER_BASE=/plotter/ pnpm build
rm -rf "$root/deploy"
mkdir -p "$root/deploy/plotter"
cp -R dist/. "$root/deploy/plotter/"
rm -f "$root/deploy/plotter/_headers"
# _headers rules match URL paths, so they need the prefix. Threads need SharedArrayBuffer,
# which needs cross-origin isolation.
cat > "$root/deploy/_headers" <<'HEADERS'
/plotter/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
HEADERS
echo "deploy/ is ready"
