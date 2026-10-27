// Reads the header at the start of a .plot2 file (PlotFile::writeData in pos2-chip 0.6.0):
// "pos2", format version, plot ID, k, strength, plot index, meta group, memo.

import type { PlotHeader } from "./protocol";

const FIXED_BYTES = 43;
const MAX_MEMO_BYTES = 255;

export async function readPlotHeader(file: File): Promise<PlotHeader> {
  const b = new Uint8Array(await file.slice(0, FIXED_BYTES + MAX_MEMO_BYTES).arrayBuffer());
  if (b.length < FIXED_BYTES || String.fromCharCode(...b.subarray(0, 4)) !== "pos2") {
    throw new Error("not a v2 plot file (missing pos2 header)");
  }
  if (b[4] !== 1) throw new Error(`unsupported plot format version ${b[4]}, expected 1`);
  const k = b[37];
  if (k < 18 || k > 32 || k % 2) throw new Error(`invalid k ${k}`);
  const memoLen = b[42];
  if (b.length < FIXED_BYTES + memoLen) throw new Error("file is truncated inside the header");
  return {
    plotId: b.slice(5, 37),
    k,
    strength: b[38],
    index: b[39] | (b[40] << 8),
    metaGroup: b[41],
    memo: b.slice(FIXED_BYTES, FIXED_BYTES + memoLen),
  };
}
