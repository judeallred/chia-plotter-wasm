// Page logic: settings form, environment checks, and the plot queue.

import initKeys, { check_address, check_public_key, derive, derive_from_memo, inspect_memo } from "./keys-pkg/plot_keys.js";
import type { FromWorker, PlotJob, Sink, Timings } from "./protocol";
import { loadDir, saveDir } from "./saved-dir";
import { startStats, type PlotStatsSource } from "./stats";
import { Validator, type Report } from "./validate";

const STORAGE_KEY = "pos2-plotter-settings";

interface Settings {
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
  gpu: boolean;
  groupSize: number;
  metaGroup: number;
  groupFolders: boolean;
  groupKeys: "separate" | "shared" | "continue";
}

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;

// A one-page module that declares a memory64 memory. Validates only if memory64 works.
const MEMORY64_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 0]);

function capabilities() {
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

function renderEnv(caps: ReturnType<typeof capabilities>) {
  const items: [boolean, string][] = [
    [caps.isolated, caps.isolated ? "Cross-origin isolated (threads available)" : "Not cross-origin isolated, so WASM threads are unavailable"],
    [true, `${caps.threads} logical CPU cores`],
    [caps.memory64, caps.memory64 ? "WebAssembly memory64 supported (k28 possible)" : "No WebAssembly memory64, so k28 is unavailable. Try a recent Chrome, Edge, or Firefox."],
    [caps.dirPicker, caps.dirPicker ? "Can save straight into a folder" : "No folder access, plots will be downloaded"],
    [true, caps.webgpu ? "WebGPU available, used for the g(x) hash when plotting and validating" : "WebGPU not available, everything runs on the CPU"],
  ];
  if (caps.deviceMemory !== undefined) {
    items.push([caps.deviceMemory >= 8, `Browser reports ${caps.deviceMemory} GB of device memory`]);
  }
  $("#env-list").innerHTML = items
    .map(([ok, text]) => `<li class="${ok ? "" : "bad"}">${text}</li>`)
    .join("");
}

function readSettings(form: HTMLFormElement): Settings {
  const f = new FormData(form);
  const s = (n: string) => String(f.get(n) ?? "").trim();
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
    gpu: s("gpu") !== "off",
    groupSize: Number(s("groupSize")),
    metaGroup: Number(s("metaGroup")),
    groupFolders: f.get("groupFolders") === "on",
    groupKeys: s("groupKeys") === "shared" ? "shared" : s("groupKeys") === "continue" ? "continue" : "separate",
  };
}

function applySettings(form: HTMLFormElement, s: Partial<Settings> | Record<string, unknown>) {
  for (const [name, value] of Object.entries(s)) {
    const els = form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
    els.forEach((el) => {
      if (el instanceof HTMLInputElement && el.type === "radio") el.checked = el.value === String(value);
      else if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = Boolean(value);
      // A saved value that matches no option would leave the select blank, so skip it.
      else if (el instanceof HTMLSelectElement && ![...el.options].some((o) => o.value === String(value))) return;
      else el.value = String(value);
    });
  }
}

function validate(s: Settings, caps: ReturnType<typeof capabilities>, continuing: boolean): Record<string, string> {
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
  if (!(s.strength >= 2 && s.strength <= 17)) errors.form = "Strength must be between 2 and 17.";
  if (!(s.threads >= 1)) errors.form = "Threads must be at least 1.";
  if (!(Number.isInteger(s.groupSize) && s.groupSize >= 1 && s.groupSize <= 65535)) errors.form = "Plots per group must be 1 to 65535.";
  if (!(Number.isInteger(s.metaGroup) && s.metaGroup >= 0 && s.metaGroup <= 255)) errors.form = "Meta group must be 0 to 255.";
  if (!(s.count >= 0)) errors.form = "Number of plots cannot be negative.";
  if (!caps.isolated) errors.form = "This page is not cross-origin isolated, so the plotter cannot run.";
  if (s.k > 26 && !caps.memory64) errors.form = "k28 needs WebAssembly memory64, which this browser lacks.";
  return errors;
}

// The fields of a plot header the page needs, read from the start of the file.
interface PlotFileInfo {
  k: number;
  strength: number;
  index: number;
  metaGroup: number;
  memo: Uint8Array;
  groupId: string;
  farmerKey: string;
  pool: string;
}

async function readPlotInfo(file: File): Promise<PlotFileInfo | null> {
  const b = new Uint8Array(await file.slice(0, 43 + 255).arrayBuffer());
  if (b.length < 43 || String.fromCharCode(...b.subarray(0, 4)) !== "pos2" || b[4] !== 1) return null;
  const memo = b.slice(43, 43 + b[42]);
  const info = { k: b[37], strength: b[38], index: b[39] | (b[40] << 8), metaGroup: b[41], memo };
  try {
    const m = inspect_memo(memo, info.strength, info.index, info.metaGroup, "xch");
    const out = { ...info, groupId: m.plot_group_id_hex, farmerKey: m.farmer_public_key, pool: m.pool_contract_address || m.pool_public_key };
    m.free();
    return out;
  } catch {
    return null;
  }
}

// Lists .plot2 files under dir, including subfolders, with their relative paths.
async function walkPlots(d: FileSystemDirectoryHandle, prefix = ""): Promise<{ file: File; path: string }[]> {
  const out: { file: File; path: string }[] = [];
  for await (const entry of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (entry.kind === "directory") {
      out.push(...(await walkPlots(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`)));
    } else if (entry.name.endsWith(".plot2")) {
      out.push({ file: await (entry as FileSystemFileHandle).getFile(), path: prefix + entry.name });
    }
  }
  return out;
}

// An existing group to add plots to: its keys (from a plot memo) and the indexes in use.
interface ContinueGroup {
  memo: Uint8Array;
  strength: number;
  metaGroup: number;
  groupId: string;
  farmerKey: string;
  pool: string;
  used: Set<number>;
  plots: number;
}

function fmtBytes(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} kB`;
}

function fmtMs(ms: number) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export async function start() {
  await initKeys();
  const caps = capabilities();
  renderEnv(caps);

  const form = $<HTMLFormElement>("#config");
  const startBtn = $<HTMLButtonElement>("#start");
  const stopBtn = $<HTMLButtonElement>("#stop");
  const pickBtn = $<HTMLButtonElement>("#pick-dir");
  const statusCard = $<HTMLElement>("#status");
  const statusText = $<HTMLElement>("#status-text");
  const barFill = $<HTMLElement>("#bar-fill");
  const formError = $<HTMLElement>("#form-error");
  const history = $<HTMLTableSectionElement>("#history tbody");

  applySettings(form, {
    threads: caps.threads,
    output: caps.dirPicker ? "dir" : "download",
  });
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    // Settings store gpu as a boolean, the form uses "on" and "off". Default to the GPU.
    applySettings(form, { ...saved, gpu: saved.gpu === false ? "off" : "on" });
  } catch {
    // Ignore bad saved settings.
  }
  if (!caps.dirPicker) {
    form.querySelector<HTMLInputElement>('[name="output"][value="dir"]')!.disabled = true;
    applySettings(form, { output: "download" });
    pickBtn.hidden = true;
    $<HTMLElement>("#dir-hint").hidden = true;
  }

  const syncPoolMode = () => {
    const mode = readSettings(form).poolMode;
    form.querySelectorAll<HTMLElement>("[data-mode]").forEach((el) => {
      el.hidden = el.dataset.mode !== mode;
    });
  };
  syncPoolMode();
  form.addEventListener("change", () => {
    syncPoolMode();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(readSettings(form)));
  });

  let dir: FileSystemDirectoryHandle | null = caps.dirPicker ? await loadDir() : null;
  const showDir = () => {
    $("#dir-name").textContent = dir ? `(${dir.name})` : "";
    pickBtn.textContent = dir ? "Change folder…" : "Choose folder…";
  };
  showDir();
  pickBtn.addEventListener("click", async () => {
    try {
      dir = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> })
        .showDirectoryPicker({ id: "plots", mode: "readwrite", startIn: dir ?? "documents" });
      await saveDir(dir);
      showDir();
      formError.textContent = "";
      applySettings(form, { output: "dir" });
    } catch {
      // User closed the picker, or picked a folder Chrome refuses and then cancelled.
    }
  });

  const makeWorker = () => new Worker(new URL("./plotter.worker.ts", import.meta.url), { type: "module" });
  let worker = makeWorker();
  const statsSource: PlotStatsSource = { plotterHeapBytes: 0, peakHeapBytes: 0, finished: [] };
  startStats($<HTMLElement>("#stats"), statsSource);
  const validator = new Validator();
  let running = false;
  let stopAfterCurrent = false;
  let wakeLock: { release(): Promise<void> } | null = null;
  // Plots kept in the origin private file system for download. Older ones are removed
  // once a newer plot finishes, by which time their download has long completed.
  const opfsFiles: { name: string; link: HTMLAnchorElement; checked: Promise<unknown> }[] = [];

  window.addEventListener("beforeunload", (e) => {
    if (running) e.preventDefault();
  });

  const runOne = (job: PlotJob) =>
    new Promise<{ ok: true; bytes: number; timings: Timings; file?: File } | { ok: false; reason: string }>((resolve) => {
      const started = performance.now();
      // A crash (for example running out of memory) leaves the WASM module unusable, so
      // replace the worker before the next plot.
      worker.onerror = (e) => {
        e.preventDefault();
        worker.terminate();
        worker = makeWorker();
        resolve({ ok: false, reason: `plotter crashed: ${e.message || "unknown error"}` });
      };
      worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        if (m.type === "progress") {
          if (m.heapBytes) {
            statsSource.plotterHeapBytes = m.heapBytes;
            statsSource.peakHeapBytes = Math.max(statsSource.peakHeapBytes, m.heapBytes);
          }
          const elapsed = performance.now() - started;
          const pct = (m.fraction * 100).toFixed(1);
          const eta = m.phase === "plotting" && m.fraction > 0.05 ? `, about ${fmtMs(elapsed / m.fraction - elapsed)} left` : "";
          barFill.style.width = `${100 * m.fraction}%`;
          statusText.textContent = `${job.filename}: ${m.phase === "writing" ? "writing" : pct + "%"} (${m.detail}), ${fmtMs(elapsed)} elapsed${eta}`;
        } else if (m.type === "done") {
          resolve({ ok: true, bytes: m.bytes, timings: m.timings, file: m.file });
        } else if (m.type === "cancelled") {
          resolve({ ok: false, reason: "cancelled" });
        } else if (m.type === "error") {
          resolve({ ok: false, reason: m.message });
        }
      };
      worker.postMessage({ type: "plot", job });
    });

  interface GroupInfo { strength: number; groupId: string; index: number; size: number; metaGroup: number }
  const addHistory = (filename: string, bytes: number, t: Timings, group: GroupInfo, file?: File) => {
    let link: HTMLAnchorElement | null = null;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="file"></td><td>${fmtBytes(bytes)}</td><td class="group"></td><td>${fmtMs(t.plotMs)}</td><td>${fmtMs(t.writeMs)}</td><td>${fmtMs(t.totalMs)}</td><td class="gpu"></td><td class="check">off</td><td></td>`;
    tr.querySelector(".file")!.textContent = filename;
    const groupCell = tr.querySelector<HTMLElement>(".group")!;
    const ofSize = group.size ? `/${group.size}` : "";
    groupCell.textContent = `s${group.strength} ${group.groupId.slice(0, 8)} #${group.index + 1}${ofSize} m${group.metaGroup}`;
    groupCell.title = `Strength ${group.strength}\nPlot group ID ${group.groupId}\nPlot index ${group.index}${group.size ? ` (plot ${group.index + 1} of ${group.size} in this batch)` : ", added to an existing group"}\nMeta group ${group.metaGroup}`;
    const phaseNames = ["hash", "sort", "pairs", "post sort", "misc"];
    tr.title = ["Xs", "T1", "T2", "T3"]
      .map((name, i) => `${name} ${fmtMs(t.tablesMs[i])}: ` + t.phasesMs[i].map((ms, p) => (ms ? `${phaseNames[p]} ${fmtMs(ms)}` : "")).filter(Boolean).join(", "))
      .join("\n");
    const gpuCell = tr.querySelector<HTMLElement>(".gpu")!;
    gpuCell.textContent = t.gpuMs > 0 ? `GPU ${fmtMs(t.gpuMs)}` : "CPU";
    gpuCell.title = t.gpuNote;
    if (file) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file);
      a.download = filename;
      a.textContent = "download";
      tr.lastElementChild!.append(a);
      a.click();
      link = a;
    } else {
      tr.lastElementChild!.textContent = "saved";
    }
    history.prepend(tr);
    return { link, checkCell: tr.querySelector<HTMLElement>(".check")! };
  };

  let cont: ContinueGroup | null = null;
  const contPanel = $<HTMLElement>("#continue-panel");
  const contInfo = $<HTMLElement>("#cont-info");
  const contStart = $<HTMLInputElement>("#cont-start");
  const contPick = $<HTMLSelectElement>("#cont-pick");
  const syncGroupMode = () => {
    contPanel.hidden = readSettings(form).groupKeys !== "continue";
  };
  syncGroupMode();
  form.addEventListener("change", syncGroupMode);
  if (!caps.dirPicker) $<HTMLElement>("#cont-dir").hidden = true;

  const showCont = () => {
    if (!cont) {
      contInfo.textContent = "No group chosen yet.";
      return;
    }
    // Start after the highest index seen. Gaps are left alone, since plots with those
    // indexes may exist elsewhere.
    contStart.value = String(cont.used.size ? Math.max(...cont.used) + 1 : 0);
    contInfo.textContent =
      `Group ${cont.groupId.slice(0, 16)}…, meta group ${cont.metaGroup}, strength ${cont.strength}, ` +
      `${cont.plots} plot${cont.plots === 1 ? "" : "s"} found, indexes in use: ${[...cont.used].sort((a, b) => a - b).join(", ") || "none"}. ` +
      `Farmer ${cont.farmerKey.slice(0, 12)}…, pool ${cont.pool.slice(0, 16)}…`;
  };
  showCont();

  // Groups are keyed by group ID and meta group: staggered groups share the ID.
  const loadGroups = async (files: { file: File }[]) => {
    const groups = new Map<string, ContinueGroup>();
    for (const { file } of files) {
      const info = await readPlotInfo(file);
      if (!info) continue;
      const key = `${info.groupId}:${info.metaGroup}`;
      const g = groups.get(key) ?? {
        memo: info.memo, strength: info.strength, metaGroup: info.metaGroup, groupId: info.groupId,
        farmerKey: info.farmerKey, pool: info.pool, used: new Set<number>(), plots: 0,
      };
      g.used.add(info.index);
      g.plots++;
      groups.set(key, g);
    }
    const list = [...groups.values()].sort((a, b) => b.plots - a.plots);
    contPick.innerHTML = "";
    list.forEach((g, i) => contPick.add(new Option(`${g.groupId.slice(0, 16)}… meta ${g.metaGroup}, ${g.plots} plots`, String(i))));
    $<HTMLElement>("#cont-pick-label").hidden = list.length < 2;
    contPick.onchange = () => {
      cont = list[Number(contPick.value)] ?? null;
      showCont();
    };
    cont = list[0] ?? null;
    if (!cont) contInfo.textContent = "No readable plots found there.";
    else showCont();
  };
  $<HTMLButtonElement>("#cont-dir").addEventListener("click", async () => {
    try {
      const d = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> })
        .showDirectoryPicker({ id: "plots", mode: "read" });
      contInfo.textContent = "Reading plots…";
      await loadGroups(await walkPlots(d));
    } catch {
      // Picker closed.
    }
  });
  const contFile = $<HTMLInputElement>("#cont-file");
  contFile.addEventListener("change", async () => {
    await loadGroups(Array.from(contFile.files ?? [], (file) => ({ file })));
    contFile.value = "";
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (running) return;
    const s = readSettings(form);
    const continuing = s.groupKeys === "continue";
    const errors = validate(s, caps, continuing);
    if (continuing && !cont) errors.form = "Choose the group to add to, or pick another plot group option.";
    form.querySelectorAll<HTMLElement>(".err[data-for]").forEach((el) => {
      el.textContent = errors[el.dataset.for!] ?? "";
    });
    formError.textContent = errors.form ?? (Object.keys(errors).length ? "Fix the fields above." : "");
    if (Object.keys(errors).length) return;

    let sink: Sink = { kind: "opfs" };
    if (s.output === "dir") {
      if (!dir) {
        pickBtn.click();
        formError.textContent = "Choose a folder, then press Start again.";
        return;
      }
      const perm = await (dir as unknown as { requestPermission(o: object): Promise<string> })
        .requestPermission({ mode: "readwrite" });
      if (perm !== "granted") {
        formError.textContent = "Folder permission was not granted.";
        return;
      }
      sink = { kind: "dir", dir };
    }

    if (sink.kind === "opfs") {
      const { quota = 0, usage = 0 } = await navigator.storage.estimate();
      const need = { 18: 1e6, 20: 3e6, 22: 13e6, 24: 54e6, 26: 231e6, 28: 990e6 }[s.k] ?? 1e9;
      if (quota - usage < need * 2) {
        formError.textContent = `Browser storage has ${fmtBytes(quota - usage)} free, which is not enough for this plot.`;
        return;
      }
    }

    running = true;
    stopAfterCurrent = false;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusCard.hidden = false;
    wakeLock = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } })
      .wakeLock?.request("screen").catch(() => null) ?? null;

    // A plot group is plots with the same plot key (one seed) and meta group, with indexes
    // 0..groupSize-1. Independent groups each get a new key. Staggered groups share a key
    // and step the meta group by 16, so no two of them pass the filter in the same window;
    // after 16 groups the meta groups would repeat, so a new key starts.
    const groupsPerKey = s.groupKeys === "shared" ? 16 : 1;
    let seed = new Uint8Array(32);
    const group0 = continuing ? cont : null;
    let nextIndex = Math.max(0, Number(contStart.value) || 0);
    for (let i = 0; s.count === 0 || i < s.count; i++) {
      if (stopAfterCurrent) break;
      let plotIndex: number;
      let metaGroup: number;
      let strength = s.strength;
      let d;
      if (group0) {
        // Next index not already in the group.
        while (group0.used.has(nextIndex)) nextIndex++;
        if (nextIndex > 65535) {
          statusText.textContent = "This group has no free plot indexes left.";
          break;
        }
        plotIndex = nextIndex;
        metaGroup = group0.metaGroup;
        strength = group0.strength;
        d = derive_from_memo(group0.memo, strength, plotIndex, metaGroup);
        group0.used.add(plotIndex);
        group0.plots++;
      } else {
        plotIndex = i % s.groupSize;
        const groupInKey = Math.floor(i / s.groupSize) % groupsPerKey;
        if (plotIndex === 0 && groupInKey === 0) {
          seed.fill(0);
          seed = crypto.getRandomValues(new Uint8Array(32));
        }
        metaGroup = (s.metaGroup + 16 * groupInKey) % 256;
        d = derive(seed, s.farmerKey, s.poolMode === "pk" ? s.poolKey : "", s.poolMode === "contract" ? s.poolAddress : "", strength, plotIndex, metaGroup);
      }
      const filename = `plot-k${s.k}-${d.plot_id_hex}.plot2`;
      const group = { strength, groupId: d.plot_group_id_hex, index: plotIndex, size: group0 ? 0 : s.groupSize, metaGroup };
      let plotSink: Sink = sink;
      if (sink.kind === "dir" && s.groupFolders) {
        // Staggered groups share a group ID, so the meta group is part of the folder name.
        plotSink = { kind: "dir", dir: await sink.dir.getDirectoryHandle(`group-${d.plot_group_id_hex.slice(0, 16)}-m${metaGroup}`, { create: true }) };
      }
      const job: PlotJob = {
        k: s.k, strength, plotIndex, metaGroup, plotId: d.plot_id, memo: d.memo,
        testnet: s.network === "testnet", threads: s.threads, gpu: s.gpu, filename, sink: plotSink,
      };
      d.free();
      const res = await runOne(job);
      if (!res.ok) {
        statusText.textContent = res.reason === "cancelled" ? "Stopped." : `Error: ${res.reason}`;
        break;
      }
      statsSource.finished.push({ bytes: res.bytes, ms: res.timings.totalMs });
      const { link, checkCell } = addHistory(filename, res.bytes, res.timings, group, res.file);
      let checked: Promise<unknown> = Promise.resolve();
      if (s.autoChecks > 0) {
        // Read the plot back from where it was saved, so the check also covers the write.
        const file = res.file ?? (plotSink.kind === "dir" ? await plotSink.dir.getFileHandle(filename).then((h) => h.getFile()) : undefined);
        if (file) {
          checkCell.textContent = "queued";
          checked = validator
            .check(file, { challenges: s.autoChecks, network: s.network, expectFarmerKey: group0?.farmerKey ?? s.farmerKey, gpu: s.gpu }, (p) => {
              checkCell.textContent = `${p.done}/${p.total}…`;
            })
            .then((r) => renderCheckCell(checkCell, r));
        }
      }
      if (sink.kind === "opfs" && link) {
        const root = await navigator.storage.getDirectory();
        for (const old of opfsFiles.splice(0)) {
          await old.checked;
          await root.removeEntry(old.name).catch(() => {});
          URL.revokeObjectURL(old.link.href);
          old.link.replaceWith("downloaded");
        }
        opfsFiles.push({ name: filename, link, checked });
      }
      statusText.textContent = `Finished ${filename}`;
      barFill.style.width = "100%";
    }

    seed.fill(0);
    // WASM memory never shrinks, so drop the worker (and its multi GB heap) when idle.
    worker.terminate();
    worker = makeWorker();
    statsSource.plotterHeapBytes = 0;
    running = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    await wakeLock?.release().catch(() => {});
  });

  stopBtn.addEventListener("click", () => {
    stopAfterCurrent = true;
    worker.postMessage({ type: "cancel" });
    statusText.textContent = "Stopping…";
  });

  setupValidateSection(validator, () => readSettings(form), caps.dirPicker);

  // Remove plots left in browser storage by an earlier visit.
  if (caps.opfs) {
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name.endsWith(".plot2")) await root.removeEntry(name).catch(() => {});
    }
  }
}

function renderCheckCell(cell: HTMLElement, r: Report) {
  const proofs = r.checks.find((c) => c.name === "Proofs");
  cell.innerHTML = r.ok ? `<span class="ok">✓</span> ` : `<span class="fail">✗</span> `;
  cell.append(proofs?.detail.replace(/ over .*/, "") ?? "");
  cell.title = r.checks.map((c) => `${c.ok ? "✓" : c.warn ? "!" : "✗"} ${c.name}: ${c.detail}`).join("\n");
}


function setupValidateSection(validator: Validator, settings: () => Settings, dirPicker: boolean) {
  const input = $<HTMLInputElement>("#v-files");
  const dirBtn = $<HTMLButtonElement>("#v-dir");
  const tbody = $<HTMLTableSectionElement>("#v-results tbody");
  if (!dirPicker) dirBtn.hidden = true;

  const run = async (files: { file: File; path: string }[]) => {
    const challenges = Math.max(1, Number($<HTMLInputElement>("#v-challenges").value) || 30);
    const network = $<HTMLSelectElement>("#v-network").value as "auto" | "mainnet" | "testnet";
    for (const { file, path } of files) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="file"></td>${"<td></td>".repeat(10)}<td>queued</td>`;
      tr.cells[0].textContent = path;
      tbody.prepend(tr);
      const cell = (i: number, html: string, title = "") => {
        tr.cells[i].innerHTML = html;
        tr.cells[i].title = title;
      };
      const mark = (c?: { ok: boolean; warn?: boolean; detail: string }) =>
        c ? `<span class="${c.ok ? "ok" : c.warn ? "warn" : "fail"}">${c.ok ? "✓" : c.warn ? "!" : "✗"}</span>` : "";
      validator
        .check(file, { challenges, network, expectFarmerKey: settings().farmerKey || undefined, gpu: settings().gpu }, (p) => {
          cell(6, `${p.valid}/${p.found} <small>${p.done}/${p.total}</small>`);
        })
        .then((r) => {
          const find = (name: string) => r.checks.find((c) => c.name === name);
          const h = r.header;
          cell(1, h ? String(h.k) : "");
          cell(2, h ? String(h.strength) : "");
          cell(3, r.groupId ? `<code>${r.groupId.slice(0, 8)}</code>` : "", r.groupId ?? "");
          cell(4, h ? String(h.index) : "");
          cell(5, h ? String(h.metaGroup) : "");
          const proofs = find("Proofs") ?? find("Header");
          const m = proofs?.detail.match(/^(\d+) of (\d+)/);
          cell(6, `${mark(proofs)} ${m ? `${m[1]}/${m[2]}` : ""}`, proofs?.detail ?? "");
          cell(7, mark(find("Keys")), find("Keys")?.detail ?? "");
          cell(8, mark(find("File name")), find("File name")?.detail ?? "");
          cell(9, mark(find("Farmer key")), [find("Farmer key")?.detail, r.farmerKey && `farmer ${r.farmerKey}`, r.pool && `pool ${r.pool}`].filter(Boolean).join("\n"));
          cell(10, `${(r.ms / 1000).toFixed(1)} s`);
          cell(11, r.ok ? `<span class="ok">✓ valid</span>` : `<span class="fail">✗ failed</span>`,
            r.checks.map((c) => `${c.ok ? "✓" : c.warn ? "!" : "✗"} ${c.name}: ${c.detail}`).join("\n"));
        });
    }
  };

  input.addEventListener("change", () => {
    run(Array.from(input.files ?? [], (file) => ({ file, path: file.name })));
    input.value = "";
  });
  dirBtn.addEventListener("click", async () => {
    try {
      const d = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> })
        .showDirectoryPicker({ id: "plots", mode: "read" });
      const files = await walkPlots(d);
      files.sort((a, b) => a.path.localeCompare(b.path));
      run(files);
    } catch {
      // Picker closed.
    }
  });
}
