// Headless smoke test of the WASM plotter in Node, using the same pull-based write API as
// the browser. Usage: node tools/node-plot.mjs <wasm32|wasm64> <k> <strength> <plot_id_hex> <memo_hex> <out>
import { open } from "node:fs/promises";
import path from "node:path";

const [variant, k, strength, plotIdHex, memoHex, out] = process.argv.slice(2);
const bits = variant === "wasm64" ? "64" : "32";
const dir = path.resolve(import.meta.dirname, `../core/build-${variant}`);
const { default: create } = await import(path.join(dir, `pos2w${bits}.js`));
const M = await create({
  print: (s) => console.error("[wasm]", s),
  printErr: (s) => console.error("[wasm]", s),
  onAbort: (r) => console.error("[wasm abort]", r),
});
const big = bits === "64";
// In memory64 builds pointers cross the JS boundary as BigInt. In wasm32 builds they are
// signed i32, so pointers above 2 GB arrive negative and need >>> 0.
const ptr = (p) => (big ? Number(p) : p >>> 0);
const toPtr = (n) => (big ? BigInt(n) : n);

// The heap can grow on another thread, which leaves M.HEAPU8 pointing at the old buffer.
// Always build a fresh view.
const heap = () => new Uint8Array(M.wasmMemory.buffer);
const alloc = (bytes) => {
  const p = ptr(M._malloc(toPtr(bytes.length)));
  heap().set(bytes, p);
  return p;
};
const plotId = Buffer.from(plotIdHex, "hex");
const memo = Buffer.from(memoHex, "hex");
const pId = alloc(plotId), pMemo = alloc(memo);

if (process.env.THREADS) M._pos2w_set_threads(+process.env.THREADS);
const t0 = performance.now();
const rc = M._pos2w_start(toPtr(pId), +k, +strength, 0, 0, toPtr(pMemo), memo.length, process.env.TESTNET ? 1 : 0);
if (rc !== 0) throw new Error(`start failed ${rc}`);
while (M._pos2w_status() === 1) {
  await new Promise((r) => setTimeout(r, 250));
  process.stderr.write(`\r${(M._pos2w_progress() * 100).toFixed(1)}% phase=${M._pos2w_phase()} table=${M._pos2w_table()}`);
}
process.stderr.write("\n");
if (M._pos2w_status() !== 2) throw new Error(M.UTF8ToString(M._pos2w_error()));
const t1 = performance.now();

const fh = await open(out, "w");
const headerSize = M._pos2w_begin_write();
let pos = headerSize;
for (;;) {
  const p = ptr(M._pos2w_next_chunk());
  if (!p) break;
  const len = M._pos2w_chunk_len();
  await fh.write(heap().slice(p, p + len), 0, len, pos);
  pos += len;
}
const h = ptr(M._pos2w_header());
await fh.write(heap().slice(h, h + M._pos2w_header_len()), 0, M._pos2w_header_len(), 0);
await fh.close();
const t2 = performance.now();
console.log(JSON.stringify({
  plot_ms: Math.round(t1 - t0), write_ms: Math.round(t2 - t1),
  tables_ms: [0, 1, 2, 3].map((t) => Math.round(M._pos2w_timing_ms(t))),
  threads: M._pos2w_hardware_threads(), aes: M._pos2w_has_aes(), bytes: pos,
}));
M._pos2w_reset();
process.exit(0);
