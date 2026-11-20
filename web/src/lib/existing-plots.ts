// Reading plots the user already has: to add plots to an existing group, or to keep filling
// a hard drive under its existing plot key.

import { $, canPickDirectories, pickDirectory } from "./dom";
import { inspect_memo } from "./keys-pkg/plot_keys.js";
import { readPlotHeader } from "./plot-header";

// The parts of a plot header the page needs, plus what its memo says.
export interface PlotFileInfo {
  strength: number;
  index: number;
  metaGroup: number;
  memo: Uint8Array;
  groupId: string;
  farmerKey: string;
  pool: string;
}

// Null for files that are not readable v2 plots.
export async function readPlotInfo(file: File): Promise<PlotFileInfo | null> {
  try {
    const h = await readPlotHeader(file);
    const m = inspect_memo(h.memo, h.strength, 0, h.metaGroup, "xch");
    // A plot group file of one plot is plot index 0, the only kind written today.
    const info = {
      strength: h.strength, index: 0, metaGroup: h.metaGroup, memo: h.memo,
      groupId: m.plot_group_id_hex, farmerKey: m.farmer_public_key, pool: m.pool_contract_address || m.pool_public_key,
    };
    m.free();
    return info;
  } catch {
    return null;
  }
}

export interface FoundPlot {
  file: File;
  // Relative to the folder the user chose.
  path: string;
}

// Lists .gplot files under dir, including subfolders.
export async function walkPlots(dir: FileSystemDirectoryHandle, prefix = ""): Promise<FoundPlot[]> {
  const out: FoundPlot[] = [];
  for await (const entry of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (entry.kind === "directory") {
      out.push(...(await walkPlots(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`)));
    } else if (entry.name.endsWith(".gplot")) {
      out.push({ file: await (entry as FileSystemFileHandle).getFile(), path: prefix + entry.name });
    }
  }
  return out;
}

// Keys shared by every plot in a group or on a drive, from one of its plots.
interface PlotKeys {
  memo: Uint8Array;
  strength: number;
  groupId: string;
  farmerKey: string;
  pool: string;
  plots: number;
}

// An existing group to add plots to, and the indexes in use.
export interface ContinueGroup extends PlotKeys {
  metaGroup: number;
  used: Set<number>;
}

// A drive in the hard drive layout: one plot key, plots spread over meta groups.
export interface DriveKey extends PlotKeys {
  // Per meta group: how many plots and the highest plot index seen.
  metas: Map<number, { count: number; maxIndex: number }>;
}

const keysOf = (info: PlotFileInfo): PlotKeys => ({
  memo: info.memo, strength: info.strength, groupId: info.groupId, farmerKey: info.farmerKey, pool: info.pool, plots: 0,
});

// Groups are keyed by group ID and meta group: staggered groups share the ID.
export function collectGroups(infos: PlotFileInfo[]): ContinueGroup[] {
  const groups = new Map<string, ContinueGroup>();
  for (const info of infos) {
    const key = `${info.groupId}:${info.metaGroup}`;
    const g = groups.get(key) ?? { ...keysOf(info), metaGroup: info.metaGroup, used: new Set<number>() };
    g.used.add(info.index);
    g.plots++;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.plots - a.plots);
}

// Drives are keyed by group ID, which every meta group on a drive shares.
export function collectDrives(infos: PlotFileInfo[]): DriveKey[] {
  const drives = new Map<string, DriveKey>();
  for (const info of infos) {
    const d = drives.get(info.groupId) ?? { ...keysOf(info), metas: new Map() };
    const m = d.metas.get(info.metaGroup) ?? { count: 0, maxIndex: -1 };
    m.count++;
    m.maxIndex = Math.max(m.maxIndex, info.index);
    d.metas.set(info.metaGroup, m);
    d.plots++;
    drives.set(info.groupId, d);
  }
  return [...drives.values()].sort((a, b) => b.plots - a.plots);
}

export const describeKeys = (k: PlotKeys) => `Farmer ${k.farmerKey.slice(0, 12)}…, pool ${k.pool.slice(0, 16)}…`;

// A "choose a folder or some plot files" control that reads the plots and lets the user
// pick one of what it found, when it found several. ids are the element ids of the parts.
export function setupPlotSource<T>(opts: {
  ids: { dir: string; file: string; info: string; pick: string; pickLabel: string };
  collect: (infos: PlotFileInfo[]) => T[];
  label: (item: T) => string;
  describe: (item: T) => string;
  emptyText: string;
  onChange: (item: T | null) => void;
}) {
  const info = $<HTMLElement>(`#${opts.ids.info}`);
  const pick = $<HTMLSelectElement>(`#${opts.ids.pick}`);
  const fileInput = $<HTMLInputElement>(`#${opts.ids.file}`);
  const dirBtn = $<HTMLButtonElement>(`#${opts.ids.dir}`);
  let list: T[] = [];
  const select = (item: T | null) => {
    info.textContent = item ? opts.describe(item) : opts.emptyText;
    opts.onChange(item);
  };
  const load = async (files: { file: File }[]) => {
    info.textContent = "Reading plots…";
    const infos = (await Promise.all(files.map(({ file }) => readPlotInfo(file)))).filter((i) => i !== null);
    list = opts.collect(infos);
    pick.replaceChildren(...list.map((item, i) => new Option(opts.label(item), String(i))));
    $<HTMLElement>(`#${opts.ids.pickLabel}`).hidden = list.length < 2;
    if (list.length === 0) {
      info.textContent = "No readable plots found there.";
      opts.onChange(null);
    } else {
      select(list[0]);
    }
  };
  pick.addEventListener("change", () => select(list[Number(pick.value)] ?? null));
  if (!canPickDirectories()) dirBtn.hidden = true;
  dirBtn.addEventListener("click", async () => {
    const dir = await pickDirectory("read");
    if (dir) await load(await walkPlots(dir));
  });
  fileInput.addEventListener("change", async () => {
    await load(Array.from(fileInput.files ?? [], (file) => ({ file })));
    fileInput.value = "";
  });
  info.textContent = opts.emptyText;
}
