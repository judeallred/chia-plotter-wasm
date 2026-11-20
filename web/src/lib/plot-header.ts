// Reads the header at the start of a .gplot plot group file (PlotGroupFile::Header in
// pos2-chip 1.0.1, little endian, packed): "PoS2", format version, plot group ID, k,
// strength, group size, meta group, chunk index offset, memo length, memo.

import type { PlotHeader } from "./protocol";

const FIXED_BYTES = 51;
const MAX_MEMO_BYTES = 255;
const FORMAT_VERSION = 2;

export async function readPlotHeader(file: File): Promise<PlotHeader> {
  const b = new Uint8Array(await file.slice(0, FIXED_BYTES + MAX_MEMO_BYTES).arrayBuffer());
  if (b.length < FIXED_BYTES || String.fromCharCode(...b.subarray(0, 4)) !== "PoS2") {
    throw new Error("not a v2 plot group file (missing PoS2 header)");
  }
  if (b[4] !== FORMAT_VERSION) throw new Error(`unsupported plot format version ${b[4]}, expected ${FORMAT_VERSION}`);
  const k = b[37];
  if (k < 18 || k > 28 || k % 2) throw new Error(`invalid k ${k}`);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const groupSize = view.getUint16(39, true);
  if (groupSize < 1) throw new Error("plot group has no plots");
  const memoLen = b[50];
  if (b.length < FIXED_BYTES + memoLen) throw new Error("file is truncated inside the header");
  return {
    plotGroupId: b.slice(5, 37),
    k,
    strength: b[38],
    groupSize,
    metaGroup: b[41],
    memo: b.slice(FIXED_BYTES, FIXED_BYTES + memoLen),
  };
}
