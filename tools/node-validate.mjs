// Runs the WASM validator (core/build-wasm32/pos2v) on plot files in Node, for comparing
// against tools/check_plot.py. Usage: node tools/node-validate.mjs [-n challenges] gplot...
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let n = 30;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-n") n = +args[++i];
  else files.push(path.resolve(args[i]));
}

const { default: create } = await import(path.resolve(import.meta.dirname, "../core/build-wasm32/pos2v.js"));
const M = await create({ printErr: (s) => console.error("[pos2v]", s) });
const heap = () => new Uint8Array(M.wasmMemory.buffer);
const alloc = (bytes) => { const p = M._malloc(bytes.length) >>> 0; heap().set(bytes, p); return p; };
const cstr = (s) => { const len = M.lengthBytesUTF8(s) + 1; const p = M._malloc(len) >>> 0; M.stringToUTF8(s, p, len); return p; };

let failed = false;
for (const file of files) {
  const fd = openSync(file, "r");
  const h = Buffer.alloc(64);
  readSync(fd, h, 0, 64, 0);
  closeSync(fd);
  // PlotGroupFile::Header: "PoS2", version, group ID, k, strength, group size, meta group.
  if (h.toString("latin1", 0, 4) !== "PoS2") throw new Error(`${file}: not a plot group file`);
  const groupId = h.subarray(5, 37), k = h[37], strength = h[38], metaGroup = h[41];
  const dir = path.dirname(file);
  M.FS.mkdirTree("/mnt");
  M.FS.mount(M.NODEFS, { root: dir }, "/mnt");
  const pPath = cstr("/mnt/" + path.basename(file));
  const pId = alloc(groupId);
  const pCh = M._malloc(32) >>> 0;
  let found = 0, valid = 0, proveMs = 0, solveMs = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const idx = Buffer.alloc(32);
    idx.writeBigUInt64BE(BigInt(i), 24);
    heap().set(createHash("sha256").update(idx).digest(), pCh);
    if (M._pos2v_start(pPath, pId, k, strength, metaGroup, pCh) !== 0) throw new Error("start failed");
    while (M._pos2v_status() === 1) await new Promise((r) => setTimeout(r, 2));
    if (M._pos2v_status() !== 2) {
      console.log(`  error: ${M.UTF8ToString(M._pos2v_error())}`);
      failed = true;
      break;
    }
    found += M._pos2v_found();
    proveMs += M._pos2v_prove_ms();
    solveMs += M._pos2v_solve_ms();
    valid += M._pos2v_valid();
  }
  M.FS.unmount("/mnt");
  [pPath, pId, pCh].forEach((p) => M._free(p));
  const ok = found > 0 && found === valid;
  failed ||= !ok;
  console.log(`${path.basename(file)}: k=${k} strength=${strength} proofs ${valid}/${found} valid over ${n} challenges (${((performance.now() - t0) / 1000).toFixed(1)}s, prove ${(proveMs / 1000).toFixed(1)}s, solve ${(solveMs / 1000).toFixed(1)}s) ${ok ? "OK" : "FAILED"}`);
}
process.exit(failed ? 1 : 0);
