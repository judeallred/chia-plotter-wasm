// Page logic: wires the settings form, the existing plot pickers, the plot queue, and the
// validate section together. The parts live in their own modules.

import { $, pickDirectory, wireFileButtons } from "./dom";
import { setupEstimates } from "./estimates";
import { type ContinueGroup, type DriveKey, collectDrives, collectGroups, describeKeys, setupPlotSource } from "./existing-plots";
import { fmtAgo, fmtBytes, fmtMs } from "./format";
import { History } from "./history";
import initKeys from "./keys-pkg/plot_keys.js";
import { claimPlotStorage } from "./plot-storage";
import { planPlots } from "./plan";
import type { FromWorker, PlotJob, Sink, Timings } from "./protocol";
import { loadDir, saveDir } from "./saved-dir";
import { listSessions, saveSession, startSession } from "./sessions";
import {
  type Capabilities, K_SIZES, applySettings, capabilities, readSettings, restoreSettings, summarize, validateSettings,
} from "./settings";
import { type PlotStatsSource, startStats } from "./stats";
import { setupValidateSection } from "./validate-ui";
import { Validator } from "./validate";

function renderEnv(caps: Capabilities) {
  const items: [boolean, string][] = [
    [caps.isolated, caps.isolated ? "Cross-origin isolated (threads available)" : "Not cross-origin isolated, so WASM threads are unavailable"],
    [true, `${caps.threads} logical CPU cores`],
    [caps.memory64, caps.memory64 ? "WebAssembly memory64 supported (k28 possible)" : "No WebAssembly memory64, so k28 is unavailable. Try a recent Chrome, Edge, or Firefox."],
    [caps.dirPicker, caps.dirPicker ? "Can save straight into a folder" : "No folder access, plots will be downloaded"],
    [true, caps.webgpu ? "WebGPU available, used for plotting and validating" : "WebGPU not available, everything runs on the CPU"],
  ];
  if (caps.deviceMemory !== undefined) {
    items.push([caps.deviceMemory >= 8, `Browser reports ${caps.deviceMemory} GB of device memory`]);
  }
  $("#env-list").replaceChildren(
    ...items.map(([ok, text]) => {
      const li = document.createElement("li");
      li.textContent = text;
      li.classList.toggle("bad", !ok);
      return li;
    }),
  );
}

type PlotResult = { ok: true; bytes: number; timings: Timings; file?: File } | { ok: false; reason: string };

// The plotter worker, one plot at a time. Shows progress in the status card.
class Plotter {
  private worker = Plotter.makeWorker();
  // Pause state for the current run. Paused time is left out of elapsed time and the ETA.
  paused = false;
  stopping = false;
  private pausedSince = 0;
  private pausedTotal = 0;

  constructor(
    private status: { text: HTMLElement; barFill: HTMLElement },
    private stats: PlotStatsSource,
  ) {}

  private static makeWorker() {
    return new Worker(new URL("./plotter.worker.ts", import.meta.url), { type: "module" });
  }

  run(job: PlotJob): Promise<PlotResult> {
    return new Promise((resolve) => {
      const started = performance.now();
      this.pausedTotal = 0;
      // A crash (for example running out of memory) leaves the WASM module unusable, so
      // replace the worker before the next plot.
      this.worker.onerror = (e) => {
        e.preventDefault();
        this.reset();
        resolve({ ok: false, reason: `plotter crashed: ${e.message || "unknown error"}` });
      };
      this.worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        if (m.type === "progress") {
          if (m.heapBytes) {
            this.stats.plotterHeapBytes = m.heapBytes;
            this.stats.peakHeapBytes = Math.max(this.stats.peakHeapBytes, m.heapBytes);
          }
          // Once Stop is pressed the status stays on "Stopping…" until the run ends, and while
          // paused it stays on "Paused".
          if (this.stopping || this.paused) return;
          const elapsed = performance.now() - started - this.pausedTotal;
          const pct = (m.fraction * 100).toFixed(1);
          const eta = m.phase === "plotting" && m.fraction > 0.05 ? `, about ${fmtMs(elapsed / m.fraction - elapsed)} left` : "";
          this.status.barFill.style.width = `${100 * m.fraction}%`;
          this.status.barFill.parentElement?.setAttribute("aria-valuenow", pct);
          this.status.text.textContent = `${job.filename}: ${m.phase === "writing" ? "writing" : pct + "%"} (${m.detail}), ${fmtMs(elapsed)} elapsed${eta}`;
        } else if (m.type === "done") {
          resolve({ ok: true, bytes: m.bytes, timings: m.timings, file: m.file });
        } else if (m.type === "cancelled") {
          resolve({ ok: false, reason: "cancelled" });
        } else {
          resolve({ ok: false, reason: m.message });
        }
      };
      this.worker.postMessage({ type: "plot", job });
    });
  }

  setPaused(paused: boolean) {
    if (paused === this.paused) return;
    this.paused = paused;
    this.worker.postMessage({ type: "pause", paused });
    if (paused) this.pausedSince = performance.now();
    else this.pausedTotal += performance.now() - this.pausedSince;
  }

  cancel() {
    this.stopping = true;
    // Stopping a paused plot needs it to wake up and see the cancel.
    this.setPaused(false);
    this.worker.postMessage({ type: "cancel" });
  }

  // WASM memory never shrinks, so drop the worker (and its multi GB heap) when idle.
  reset() {
    this.worker.terminate();
    this.worker = Plotter.makeWorker();
    this.stats.plotterHeapBytes = 0;
    this.paused = false;
    this.stopping = false;
  }
}

export async function start() {
  await initKeys();
  const caps = capabilities();
  renderEnv(caps);
  wireFileButtons();

  const form = $<HTMLFormElement>("#config");
  const startBtn = $<HTMLButtonElement>("#start");
  const stopBtn = $<HTMLButtonElement>("#stop");
  const pauseBtn = $<HTMLButtonElement>("#pause");
  const pickBtn = $<HTMLButtonElement>("#pick-dir");
  const statusCard = $<HTMLElement>("#status");
  const statusText = $<HTMLElement>("#status-text");
  const barFill = $<HTMLElement>("#bar-fill");
  const bar = $<HTMLElement>("#bar");
  const formError = $<HTMLElement>("#form-error");

  applySettings(form, { threads: caps.threads, output: "download" });
  // Settings used to be shared by all tabs under this key. Sessions replace it.
  localStorage.removeItem("pos2-plotter-settings");
  const session = await startSession();
  if (session.settings) restoreSettings(form, session.settings);
  if (!caps.dirPicker) {
    $<HTMLInputElement>('[name="output"][value="dir"]', form).disabled = true;
    applySettings(form, { output: "download" });
  }

  // Which controls apply: folder controls only when saving into a folder, pool fields for
  // the pool mode, and the panels of the chosen plot group option.
  const syncVisibility = () => {
    const s = readSettings(form);
    $<HTMLElement>("#dir-panel").hidden = !caps.dirPicker || s.output !== "dir";
    // Always shown so plot groups are easy to discover, but only used with groups.
    $<HTMLElement>("#group-folders-note").textContent = s.groupKeys === "none"
      ? "Used with plot groups, see Plot groups above. Without groups every plot has its own key, so plots stay in the chosen folder."
      : "";
    form.querySelectorAll<HTMLElement>("[data-mode]").forEach((el) => (el.hidden = el.dataset.mode !== s.poolMode));
    form.querySelectorAll<HTMLElement>("[data-group-modes]").forEach((el) => {
      el.hidden = !(el.dataset.groupModes ?? "").split(" ").includes(s.groupKeys);
    });
    $<HTMLElement>("#continue-panel").hidden = s.groupKeys !== "continue";
    $<HTMLElement>("#drive-continue").hidden = s.driveStart !== "continue";
  };
  syncVisibility();
  form.addEventListener("change", syncVisibility);

  // Existing plots to continue from: a group to add to, or a drive to keep filling.
  let cont: ContinueGroup | null = null;
  let drive: DriveKey | null = null;
  const estimates = setupEstimates(form, caps, {
    groupStrength: () => cont?.strength ?? null,
    driveStrength: () => drive?.strength ?? null,
  });
  const contStart = $<HTMLInputElement>("#cont-start");
  setupPlotSource({
    ids: { dir: "cont-dir", file: "cont-file", info: "cont-info", pick: "cont-pick", pickLabel: "cont-pick-label" },
    collect: collectGroups,
    label: (g) => `${g.groupId.slice(0, 16)}… meta ${g.metaGroup}, ${g.plots} plots`,
    describe: (g) =>
      `Group ${g.groupId.slice(0, 16)}…, meta group ${g.metaGroup}, strength ${g.strength}, ` +
      `${g.plots} plot${g.plots === 1 ? "" : "s"} found, indexes in use: ${[...g.used].sort((a, b) => a - b).join(", ") || "none"}. ` +
      describeKeys(g),
    emptyText: "No group chosen yet.",
    onChange: (g) => {
      cont = g;
      // Start after the highest index seen. Gaps are left alone, since plots with those
      // indexes may exist elsewhere.
      if (g) contStart.value = String(g.used.size ? Math.max(...g.used) + 1 : 0);
      estimates.refresh();
    },
  });
  setupPlotSource({
    ids: { dir: "drive-dir", file: "drive-file", info: "drive-info", pick: "drive-pick", pickLabel: "drive-pick-label" },
    collect: collectDrives,
    label: (d) => `${d.groupId.slice(0, 16)}…, ${d.plots} plots`,
    describe: (d) => {
      const used = [...d.metas.entries()].sort((a, b) => a[0] - b[0]).map(([m, v]) => `${m}:${v.count}`).join(" ");
      return `Plot key ${d.groupId.slice(0, 16)}…, strength ${d.strength}, ${d.plots} plots found. ` +
        `Plots per meta group: ${used || "none"}. ${describeKeys(d)}`;
    },
    emptyText: "No drive chosen yet.",
    onChange: (d) => {
      drive = d;
      estimates.refresh();
    },
  });

  // Keep this tab's session up to date, and offer other sessions to load.
  const sessionPick = $<HTMLSelectElement>("#session-pick");
  let saveTimer = 0;
  const saveNow = () => {
    const s = readSettings(form);
    saveSession(session.id, s as unknown as Record<string, unknown>, summarize(s));
  };
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, 300);
  };
  form.addEventListener("input", saveSoon);
  form.addEventListener("change", saveSoon);
  window.addEventListener("pagehide", saveNow);
  const fillSessions = () => {
    const keep = sessionPick.options[0];
    sessionPick.replaceChildren(keep);
    for (const rec of listSessions()) {
      if (rec.id !== session.id) sessionPick.add(new Option(`${rec.summary} · ${fmtAgo(rec.updated)}`, rec.id));
    }
    // Hidden until another tab or an earlier session has saved settings.
    $<HTMLElement>("#sessions").hidden = sessionPick.options.length < 2;
  };
  fillSessions();
  sessionPick.addEventListener("focus", fillSessions);
  sessionPick.addEventListener("pointerdown", fillSessions);
  window.addEventListener("storage", fillSessions);

  let dir: FileSystemDirectoryHandle | null = caps.dirPicker ? await loadDir(session.id) : null;
  const showDir = () => {
    $("#dir-name").textContent = dir ? `(${dir.name})` : "";
    pickBtn.textContent = dir ? "Change folder…" : "Choose folder…";
  };
  showDir();
  sessionPick.addEventListener("change", async () => {
    const rec = listSessions().find((r) => r.id === sessionPick.value);
    sessionPick.value = "";
    if (!rec) return;
    restoreSettings(form, rec.settings);
    // Rerun everything that reacts to the form, then save this tab's copy.
    form.dispatchEvent(new Event("change"));
    form.dispatchEvent(new Event("input"));
    const other = caps.dirPicker ? await loadDir(rec.id) : null;
    if (other) {
      dir = other;
      await saveDir(session.id, other);
      showDir();
    }
    saveNow();
    statusCard.hidden = false;
    statusText.textContent = `Loaded settings from: ${rec.summary}`;
  });
  pickBtn.addEventListener("click", async () => {
    const picked = await pickDirectory("readwrite", dir ?? "documents");
    if (!picked) return;
    dir = picked;
    await saveDir(session.id, dir);
    showDir();
    formError.textContent = "";
    applySettings(form, { output: "dir" });
  });

  const statsSource: PlotStatsSource = { plotterHeapBytes: 0, peakHeapBytes: 0, finished: [], gpuPlots: 0, gpuMs: 0, lastGpuNote: "", lastUsedGpu: null };
  startStats($<HTMLElement>("#stats"), statsSource);
  const plotter = new Plotter({ text: statusText, barFill }, statsSource);
  const validator = new Validator();
  const history = new History();
  const storage = caps.opfs ? await claimPlotStorage(session.id) : null;
  let running = false;

  window.addEventListener("beforeunload", (e) => {
    if (running) e.preventDefault();
  });

  // Where plots go: the chosen folder, or browser storage for download. Null, with the
  // reason shown, if neither is possible right now.
  const resolveSink = async (s: ReturnType<typeof readSettings>): Promise<Sink | null> => {
    if (s.output === "dir") {
      if (!dir) {
        pickBtn.click();
        formError.textContent = "Choose a folder, then press Start again.";
        return null;
      }
      const perm = await (dir as unknown as { requestPermission(o: object): Promise<string> }).requestPermission({ mode: "readwrite" });
      if (perm !== "granted") {
        formError.textContent = "Folder permission was not granted.";
        return null;
      }
      return { kind: "dir", dir };
    }
    if (!storage) {
      formError.textContent = "This browser has no storage for downloads.";
      return null;
    }
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (quota - usage < (K_SIZES[s.k]?.bytes ?? 1e9) * 2) {
      formError.textContent = `Browser storage has ${fmtBytes(quota - usage)} free, which is not enough for this plot.`;
      return null;
    }
    return { kind: "opfs", folder: storage.folder };
  };

  const plotAll = async (s: ReturnType<typeof readSettings>, sink: Sink) => {
    const expectFarmerKey =
      (s.groupKeys === "continue" ? cont?.farmerKey : undefined) ??
      (s.groupKeys === "drive" && s.driveStart === "continue" ? drive?.farmerKey : undefined) ??
      s.farmerKey;
    const plan = planPlots(s, { group: cont, drive, firstIndex: Number(contStart.value) || 0 });
    try {
      for (let next = plan.next(); ; next = plan.next()) {
        if (next.done) {
          if (next.value) statusText.textContent = next.value;
          return;
        }
        if (plotter.stopping) return;
        const { derived, group } = next.value;
        const filename = `plot-k${s.k}-${derived.plot_id_hex}.plot2`;
        let plotSink = sink;
        if (sink.kind === "dir" && s.groupFolders && s.groupKeys !== "none") {
          // One folder per plot key (group ID). Meta groups of the same key share it, so a hard
          // drive layout's 16 meta groups, or staggered groups, stay together.
          plotSink = { kind: "dir", dir: await sink.dir.getDirectoryHandle(`group-${group.groupId.slice(0, 16)}`, { create: true }) };
        }
        const job: PlotJob = {
          k: s.k, strength: group.strength, plotIndex: group.index, metaGroup: group.metaGroup,
          plotId: derived.plot_id, memo: derived.memo, testnet: s.network === "testnet", threads: s.threads, gpu: s.gpu,
          filename, sink: plotSink,
        };
        derived.free();
        const res = await plotter.run(job);
        if (!res.ok) {
          statusText.textContent = res.reason === "cancelled" ? "Stopped." : `Error: ${res.reason}`;
          // A stopped or failed plot has no progress left to show.
          bar.hidden = true;
          return;
        }
        statsSource.finished.push({ bytes: res.bytes, ms: res.timings.totalMs });
        statsSource.lastUsedGpu = res.timings.gpuMs > 0;
        statsSource.lastGpuNote = res.timings.gpuNote;
        if (res.timings.gpuMs > 0) {
          statsSource.gpuPlots++;
          statsSource.gpuMs += res.timings.gpuMs;
        }
        const row = history.add(filename, res.bytes, res.timings, group, res.file);
        let checked: Promise<unknown> = Promise.resolve();
        if (s.autoChecks > 0) {
          // Read the plot back from where it was saved, so the check also covers the write.
          const file = res.file ?? (plotSink.kind === "dir" ? await (await plotSink.dir.getFileHandle(filename)).getFile() : undefined);
          if (file) {
            row.setCheck(`<span class="pill pill-muted">queued</span>`);
            checked = validator
              .check(file, { challenges: s.autoChecks, network: s.network, expectFarmerKey, gpu: s.gpu !== "off" }, (p) => {
                row.setCheck(`<span class="pill pill-muted">checking ${p.done}/${p.total}</span>`);
              })
              .then(row.showReport);
          }
        }
        if (storage && row.link) await storage.keep(filename, row.link, checked);
        statusText.textContent = `Finished ${filename}`;
        barFill.style.width = "100%";
      }
    } finally {
      // Wipes the plan's seeds if it stopped early.
      plan.return(undefined);
    }
  };

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (running) return;
    const s = readSettings(form);
    const driveContinue = s.groupKeys === "drive" && s.driveStart === "continue";
    const errors = validateSettings(s, caps, s.groupKeys === "continue" || driveContinue);
    if (s.groupKeys === "continue" && !cont) errors.form = "Choose the group to add to, or pick another plot group option.";
    if (driveContinue && !drive) errors.form = "Choose the drive's plot folder or one of its plots, or pick Start a new drive.";
    form.querySelectorAll<HTMLElement>(".err[data-for]").forEach((el) => {
      el.textContent = errors[el.dataset.for ?? ""] ?? "";
    });
    formError.textContent = errors.form ?? (Object.keys(errors).length ? "Fix the fields above." : "");
    if (Object.keys(errors).length) return;
    const sink = await resolveSink(s);
    if (!sink) return;

    running = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    pauseBtn.disabled = false;
    pauseBtn.textContent = "Pause";
    statusCard.hidden = false;
    bar.hidden = false;
    barFill.style.width = "0%";
    const wakeLock = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } })
      .wakeLock?.request("screen").catch(() => null) ?? null;
    try {
      await plotAll(s, sink);
    } catch (e) {
      statusText.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      bar.hidden = true;
    } finally {
      plotter.reset();
      running = false;
      startBtn.disabled = false;
      stopBtn.disabled = true;
      pauseBtn.disabled = true;
      pauseBtn.textContent = "Pause";
      await wakeLock?.release().catch(() => {});
    }
  });

  pauseBtn.addEventListener("click", () => {
    plotter.setPaused(!plotter.paused);
    pauseBtn.textContent = plotter.paused ? "Resume" : "Pause";
    statusText.textContent = plotter.paused ? "Paused. The plot stays in memory until you resume." : "Resuming…";
  });

  stopBtn.addEventListener("click", () => {
    stopBtn.disabled = true;
    pauseBtn.disabled = true;
    plotter.cancel();
    statusText.textContent = "Stopping…";
  });

  setupValidateSection(validator, () => readSettings(form));
}
