// The plot settings form: reading, restoring and checking it, and what the browser can do.

import { check_address, check_public_key } from "./keys-pkg/plot_keys.js";
import type { GpuMode } from "./protocol";

export type GroupKeys = "none" | "drive" | "separate" | "shared" | "continue";

export interface Settings {
  farmerKey: string;
  poolMode: "contract" | "pk";
  poolAddress: string;
  poolKey: string;
  strength: number;
  k: number;
  count: number;
  threads: number;
  network: "mainnet" | "testnet";
  output: "dir" | "download";
  autoChecks: number;
  // gpu: tables on the GPU. hybrid: tables split between CPU and GPU. off: CPU only.
  gpu: GpuMode;
  groupSize: number;
  metaGroup: number;
  groupFolders: boolean;
  groupKeys: GroupKeys;
  driveStart: "new" | "continue";
  driveMetas: number;
  // Size of the drive being filled, in TB. Only used for estimates on the page.
  driveTB: number;
}

// A one-page module that declares a memory64 memory. Validates only if memory64 works.
const MEMORY64_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 0]);

export function capabilities() {
  return {
    isolated: self.crossOriginIsolated === true,
    threads: navigator.hardwareConcurrency || 4,
    memory64: WebAssembly.validate(MEMORY64_PROBE),
    dirPicker: "showDirectoryPicker" in window,
    opfs: !!navigator.storage?.getDirectory,
    webgpu: "gpu" in navigator,
    deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory,
  };
}

export type Capabilities = ReturnType<typeof capabilities>;

// Per k: plot file size in bytes, and the size, peak plotter memory and plotting time at
// strength 2 as shown under the size field (Chrome on an M4 Pro, 14 cores, 20 core GPU).
export const K_SIZES: Record<number, { bytes: number; file: string; memory: string; gpu: string; cpu: string }> = {
  28: { bytes: 990e6, file: "about 1 GB", memory: "about 11 GB", gpu: "about 40 seconds", cpu: "2 minutes" },
  26: { bytes: 231e6, file: "about 230 MB", memory: "about 3 GB", gpu: "about 5 seconds", cpu: "30 seconds" },
  24: { bytes: 54e6, file: "about 53 MB", memory: "about 0.7 GB", gpu: "about 2 seconds", cpu: "7 seconds" },
  22: { bytes: 13e6, file: "about 12 MB", memory: "about 0.3 GB", gpu: "under a second", cpu: "2 seconds" },
  20: { bytes: 3e6, file: "about 3 MB", memory: "under 0.1 GB", gpu: "under a second", cpu: "under a second" },
  18: { bytes: 1e6, file: "about 0.6 MB", memory: "under 0.1 GB", gpu: "under a second", cpu: "under a second" },
};

// Drive estimates assume k28, the only farmable size. A 4 TB drive holds about 4,000.
export const drivePlotsOf = (s: Settings) => Math.max(1, Math.round(((s.driveTB > 0 ? s.driveTB : 4) * 1e12) / 1e9));
export const fmtTB = (tb: number) => `${(tb > 0 ? tb : 4).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB`;

// The plot group options that can be chosen today. pos2-chip 1.0.1 only writes plot group
// files of one plot, and its prover reads such a file as plot index 0, so a plot at any
// other index cannot be farmed. Every mode that plots several indexes under one plot key
// waits for an upstream writer of multi-plot group files. Their form options stay on the
// page, disabled.
export const AVAILABLE_GROUP_KEYS: readonly GroupKeys[] = ["none"];
const GPU_MODES: readonly GpuMode[] = ["gpu", "hybrid", "off"];

export function readSettings(form: HTMLFormElement): Settings {
  const f = new FormData(form);
  const s = (n: string) => String(f.get(n) ?? "").trim();
  const oneOf = <T extends string>(value: string, options: readonly T[], fallback: T) =>
    options.find((o) => o === value) ?? fallback;
  return {
    farmerKey: s("farmerKey"),
    poolMode: s("poolMode") === "pk" ? "pk" : "contract",
    poolAddress: s("poolAddress"),
    poolKey: s("poolKey"),
    strength: Number(s("strength")),
    k: Number(s("k")),
    count: Number(s("count")),
    threads: Number(s("threads")),
    network: s("network") === "testnet" ? "testnet" : "mainnet",
    output: s("output") === "dir" ? "dir" : "download",
    autoChecks: Number(s("autoChecks")),
    gpu: oneOf(s("gpu"), GPU_MODES, "gpu"),
    groupSize: Number(s("groupSize")),
    metaGroup: Number(s("metaGroup")),
    groupFolders: f.get("groupFolders") === "on",
    groupKeys: oneOf(s("groupKeys"), AVAILABLE_GROUP_KEYS, "none"),
    driveStart: s("driveStart") === "continue" ? "continue" : "new",
    driveMetas: Number(s("driveMetas")),
    driveTB: Number(s("driveTB")),
  };
}

// Sets form fields by name. Values that fit no field or option are ignored, so settings
// saved by an older version of the page cannot break the form.
export function applySettings(form: HTMLFormElement, s: Partial<Settings> | Record<string, unknown>) {
  for (const [name, value] of Object.entries(s)) {
    const els = form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[name="${CSS.escape(name)}"]`);
    els.forEach((el) => {
      if (el instanceof HTMLInputElement && el.type === "radio") el.checked = el.value === String(value);
      else if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = Boolean(value);
      // A saved value that matches no option would leave the select blank, so skip it.
      else if (el instanceof HTMLSelectElement && ![...el.options].some((o) => o.value === String(value))) return;
      else el.value = String(value);
    });
  }
}

// Applies settings saved in a session. Older sessions stored gpu as a boolean.
export function restoreSettings(form: HTMLFormElement, saved: Record<string, unknown>) {
  applySettings(form, { ...saved, gpu: saved.gpu === false ? "off" : saved.gpu === true ? "gpu" : saved.gpu });
}

// Field errors keyed by field name, and form level errors under "form".
export function validateSettings(s: Settings, caps: Capabilities, continuing: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  // When adding to an existing group, keys come from the group's plots, not the form.
  if (!continuing) {
    const farmerErr = s.farmerKey ? check_public_key(s.farmerKey) : "required";
    if (farmerErr) errors.farmerKey = farmerErr;
    if (s.poolMode === "contract") {
      const e = s.poolAddress ? check_address(s.poolAddress) : "required";
      if (e) errors.poolAddress = e;
    } else {
      const e = s.poolKey ? check_public_key(s.poolKey) : "required";
      if (e) errors.poolKey = e;
    }
  }
  const formErrors = [
    [!(s.strength >= 2 && s.strength <= 17), "Strength must be between 2 and 17."],
    [!(s.threads >= 1), "Threads must be at least 1."],
    [!(Number.isInteger(s.groupSize) && s.groupSize >= 1 && s.groupSize <= 65535), "Plots per group must be 1 to 65535."],
    [!(Number.isInteger(s.metaGroup) && s.metaGroup >= 0 && s.metaGroup <= 255), "Meta group must be 0 to 255."],
    [!(s.count >= 0), "Number of plots cannot be negative."],
    [
      s.groupKeys === "drive" && !(Number.isInteger(s.driveMetas) && s.driveMetas >= 1 && s.driveMetas <= 256),
      "Meta groups per drive must be 1 to 256.",
    ],
    [!caps.isolated, "This page is not cross-origin isolated, so the plotter cannot run."],
    [s.k > 26 && !caps.memory64, "k28 needs WebAssembly memory64, which this browser lacks."],
  ] as const;
  const first = formErrors.find(([bad]) => bad);
  if (first) errors.form = first[1];
  return errors;
}

// A short label for a session in the Recent sessions list.
export function summarize(s: Settings): string {
  const mode: Record<GroupKeys, string> = {
    none: "no groups",
    drive: s.driveStart === "continue" ? "hard drive (continue)" : "hard drive",
    separate: "independent groups",
    shared: "staggered groups",
    continue: "add to group",
  };
  const farmer = s.farmerKey ? `farmer ${s.farmerKey.slice(0, 8)}…` : "no farmer key";
  const plots = s.count === 0 ? "until stopped" : `${s.count} plot${s.count === 1 ? "" : "s"}`;
  return `k${s.k} · strength ${s.strength} · ${mode[s.groupKeys]} · ${plots} · ${farmer}`;
}
