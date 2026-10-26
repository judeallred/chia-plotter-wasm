// Page logic: settings form, environment checks, and the plot queue.

import initKeys, { check_address, check_public_key, derive } from "./keys-pkg/plot_keys.js";
import type { FromWorker, PlotJob, Sink, Timings } from "./protocol";
import { loadDir, saveDir } from "./saved-dir";

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
    [true, caps.webgpu ? "WebGPU available (not used by the plotter yet)" : "WebGPU not available"],
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
  };
}

function applySettings(form: HTMLFormElement, s: Partial<Settings>) {
  for (const [name, value] of Object.entries(s)) {
    const els = form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
    els.forEach((el) => {
      if (el instanceof HTMLInputElement && el.type === "radio") el.checked = el.value === String(value);
      else el.value = String(value);
    });
  }
}

function validate(s: Settings, caps: ReturnType<typeof capabilities>): Record<string, string> {
  const errors: Record<string, string> = {};
  const farmerErr = s.farmerKey ? check_public_key(s.farmerKey) : "required";
  if (farmerErr) errors.farmerKey = farmerErr;
  if (s.poolMode === "contract") {
    const e = s.poolAddress ? check_address(s.poolAddress) : "required";
    if (e) errors.poolAddress = e;
  } else {
    const e = s.poolKey ? check_public_key(s.poolKey) : "required";
    if (e) errors.poolKey = e;
  }
  if (!(s.strength >= 2 && s.strength <= 17)) errors.form = "Strength must be between 2 and 17.";
  if (!(s.threads >= 1)) errors.form = "Threads must be at least 1.";
  if (!(s.count >= 0)) errors.form = "Number of plots cannot be negative.";
  if (!caps.isolated) errors.form = "This page is not cross-origin isolated, so the plotter cannot run.";
  if (s.k > 26 && !caps.memory64) errors.form = "k28 needs WebAssembly memory64, which this browser lacks.";
  return errors;
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
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Settings>;
    applySettings(form, saved);
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
  let running = false;
  let stopAfterCurrent = false;
  let wakeLock: { release(): Promise<void> } | null = null;
  // Plots kept in the origin private file system for download. Older ones are removed
  // once a newer plot finishes, by which time their download has long completed.
  const opfsFiles: { name: string; link: HTMLAnchorElement }[] = [];

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

  const addHistory = (filename: string, bytes: number, t: Timings, file?: File): HTMLAnchorElement | null => {
    let link: HTMLAnchorElement | null = null;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="file"></td><td>${fmtBytes(bytes)}</td><td>${fmtMs(t.plotMs)}</td><td>${fmtMs(t.writeMs)}</td><td>${fmtMs(t.totalMs)}</td><td></td>`;
    tr.querySelector(".file")!.textContent = filename;
    tr.title = `Xs ${fmtMs(t.tablesMs[0])}, T1 ${fmtMs(t.tablesMs[1])}, T2 ${fmtMs(t.tablesMs[2])}, T3 ${fmtMs(t.tablesMs[3])}`;
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
    return link;
  };

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (running) return;
    const s = readSettings(form);
    const errors = validate(s, caps);
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

    for (let i = 0; s.count === 0 || i < s.count; i++) {
      if (stopAfterCurrent) break;
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const d = derive(seed, s.farmerKey, s.poolMode === "pk" ? s.poolKey : "", s.poolMode === "contract" ? s.poolAddress : "", s.strength, 0, 0);
      const filename = `plot-k${s.k}-${d.plot_id_hex}.plot2`;
      seed.fill(0);
      const job: PlotJob = {
        k: s.k, strength: s.strength, plotId: d.plot_id, memo: d.memo,
        testnet: s.network === "testnet", threads: s.threads, filename, sink,
      };
      d.free();
      const res = await runOne(job);
      if (!res.ok) {
        statusText.textContent = res.reason === "cancelled" ? "Stopped." : `Error: ${res.reason}`;
        break;
      }
      const link = addHistory(filename, res.bytes, res.timings, res.file);
      if (sink.kind === "opfs" && link) {
        const root = await navigator.storage.getDirectory();
        for (const old of opfsFiles.splice(0)) {
          await root.removeEntry(old.name).catch(() => {});
          URL.revokeObjectURL(old.link.href);
          old.link.replaceWith("downloaded");
        }
        opfsFiles.push({ name: filename, link });
      }
      statusText.textContent = `Finished ${filename}`;
      barFill.style.width = "100%";
    }

    // WASM memory never shrinks, so drop the worker (and its multi GB heap) when idle.
    worker.terminate();
    worker = makeWorker();
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

  // Remove plots left in browser storage by an earlier visit.
  if (caps.opfs) {
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name.endsWith(".plot2")) await root.removeEntry(name).catch(() => {});
    }
  }
}
