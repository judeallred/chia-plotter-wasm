// Live stats panel. Browsers hide most system information, so this shows what the page can
// actually see: its own memory, CPU pressure, battery, storage quota, and plotting rate.

import { escapeHtml, fmtBytes, fmtMs } from "./format";

type PressureState = "nominal" | "fair" | "serious" | "critical";

interface Battery {
  level: number;
  charging: boolean;
  addEventListener(t: string, f: () => void): void;
}

export interface PlotStatsSource {
  plotterHeapBytes: number;
  // Largest plotter heap seen this session. WASM memory only grows, so this is the high water mark.
  peakHeapBytes: number;
  finished: { bytes: number; ms: number }[];
  // Finished plots that used the GPU, and the GPU time they reported.
  gpuPlots: number;
  gpuMs: number;
  // What the GPU did for the last plot, or why it used the CPU.
  lastGpuNote: string;
  lastUsedGpu: boolean | null;
}

export function startStats(el: HTMLElement, source: PlotStatsSource) {
  const values = new Map<string, { text: string; bad?: boolean; title?: string }>();
  const order = ["cpu", "pressure", "devmem", "plotter", "tab", "battery", "storage", "rate", "gpu", "gpulimits", "gpuwork"];

  const render = () => {
    el.innerHTML = order
      .filter((k) => values.has(k))
      .map((k) => {
        const v = values.get(k);
        if (!v) return "";
        return `<div class="stat${v.bad ? " bad" : ""}"${v.title ? ` title="${escapeHtml(v.title)}"` : ""}>${v.text}</div>`;
      })
      .join("");
  };
  const set = (key: string, text: string, bad = false, title?: string) => {
    values.set(key, { text, bad, title });
    render();
  };

  set("cpu", `<b>${navigator.hardwareConcurrency}</b> CPU threads`);
  const dm = (navigator as { deviceMemory?: number }).deviceMemory;
  if (dm !== undefined) {
    set("devmem", `<b>${dm} GB</b> device RAM`, false, "Rounded, and capped by the browser. Free system memory is not visible to web pages.");
  }

  // CPU pressure (Chrome 125+). The browser reports a coarse state, not a percentage.
  const PO = (globalThis as { PressureObserver?: new (cb: (r: { state: PressureState }[]) => void) => { observe(s: string, o?: object): Promise<void> } }).PressureObserver;
  if (PO) {
    const label: Record<PressureState, string> = {
      nominal: "CPU pressure: nominal",
      fair: "CPU pressure: fair",
      serious: "CPU pressure: serious",
      critical: "CPU pressure: critical (throttling likely)",
    };
    const obs = new PO((records) => {
      const s = records[records.length - 1].state;
      set("pressure", label[s], s === "critical", "Reported by the browser. Serious or critical usually means thermal limits or other heavy apps.");
    });
    obs.observe("cpu", { sampleInterval: 2000 }).catch(() => {});
  }

  // Battery (Chrome). Long plots on battery drain it fast.
  const getBattery = (navigator as { getBattery?: () => Promise<Battery> }).getBattery;
  if (getBattery) {
    getBattery.call(navigator).then((b) => {
      const update = () =>
        set("battery", `Battery <b>${Math.round(b.level * 100)}%</b>${b.charging ? " charging" : " on battery"}`, !b.charging && b.level < 0.3);
      update();
      b.addEventListener("levelchange", update);
      b.addEventListener("chargingchange", update);
    }).catch(() => {});
  }

  // WebGPU exposes the adapter's identity, limits and features, not utilization,
  // temperature or memory use.
  type Adapter = {
    info?: { vendor: string; architecture: string; device: string; description: string };
    limits: { maxBufferSize: number; maxStorageBufferBindingSize: number };
    features: Set<string>;
    isFallbackAdapter?: boolean;
  };
  const gpu = (navigator as { gpu?: { requestAdapter(o?: object): Promise<Adapter | null> } }).gpu;
  if (!gpu) set("gpu", "No WebGPU, plotting uses the CPU");
  gpu?.requestAdapter({ powerPreference: "high-performance" }).then((a) => {
    if (!a) {
      set("gpu", "WebGPU present but no adapter, plotting uses the CPU", true);
      return;
    }
    const name = [a.info?.vendor, a.info?.architecture, a.info?.device].filter(Boolean).join(" ") || "unknown adapter";
    set("gpu", `GPU <b>${escapeHtml(name)}</b>${a.isFallbackAdapter ? " (software fallback)" : ""}`, false, a.info?.description || "");
    const notable = ["shader-f16", "timestamp-query", "subgroups"].filter((f) => a.features.has(f));
    set(
      "gpulimits",
      `GPU buffers up to <b>${fmtBytes(a.limits.maxBufferSize)}</b>` + (notable.length ? `, ${notable.join(", ")}` : ""),
      false,
      `Largest buffer ${fmtBytes(a.limits.maxBufferSize)}, largest storage binding ${fmtBytes(a.limits.maxStorageBufferBindingSize)}. Features: ${[...a.features].sort().join(", ")}`,
    );
  }).catch(() => {});

  const tick = async () => {
    const peak = source.peakHeapBytes ? `, peak ${fmtBytes(source.peakHeapBytes)}` : "";
    set("plotter", `Plotter heap <b>${source.plotterHeapBytes ? fmtBytes(source.plotterHeapBytes) : "idle"}</b>${peak}`, false, "WebAssembly memory held by the plotter. It is released when plotting stops.");

    // Memory for this whole page, including workers and WASM. Needs cross origin isolation.
    const measure = (performance as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> }).measureUserAgentSpecificMemory;
    if (measure && self.crossOriginIsolated) {
      measure.call(performance).then((m) => set("tab", `This tab <b>${fmtBytes(m.bytes)}</b>`)).catch(() => {});
    }

    const est = await navigator.storage?.estimate?.().catch(() => undefined);
    if (est?.quota) {
      set("storage", `Browser storage ${fmtBytes(est.usage ?? 0)} of ${fmtBytes(est.quota)}`, false, "Used for downloads. Saving into a folder does not use it.");
    }

    if (source.lastUsedGpu !== null) {
      if (source.gpuPlots > 0) {
        set(
          "gpuwork",
          `GPU work: <b>${source.gpuPlots}</b> plot${source.gpuPlots === 1 ? "" : "s"}, about <b>${fmtMs(source.gpuMs / source.gpuPlots)}</b> of GPU time each`,
          false,
          `Last plot: ${source.lastGpuNote}. GPU time includes moving data between the plotter and the GPU.`,
        );
      } else {
        set("gpuwork", `Last plot ran on the CPU: ${escapeHtml(source.lastGpuNote || "GPU off")}`, !source.lastUsedGpu && source.lastGpuNote !== "GPU off in settings");
      }
    }

    const f = source.finished;
    if (f.length) {
      const bytes = f.reduce((a, p) => a + p.bytes, 0);
      const ms = f.reduce((a, p) => a + p.ms, 0);
      const perDay = (bytes / ms) * 86_400_000;
      set("rate", `<b>${f.length}</b> plots, ${fmtBytes(bytes)}, about <b>${fmtBytes(perDay)}/day</b> at this rate`);
    }
  };
  tick();
  setInterval(tick, 5000);
}
