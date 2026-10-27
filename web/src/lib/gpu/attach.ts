// Attaching the GPU to a WASM module for one plot or one validation: create the device once
// per worker, self test it against the module's CPU code, then serve the module's requests.

import { GpuG, type PairStats } from "./device";
import { type GpuHost, fn } from "./host";
import { type SelfTestParams, selfTest } from "./selftest";
import { serve } from "./serve";

// Per worker. Once the GPU fails, failure says why and the worker stops trying.
export interface GpuWorkerState {
  device?: GpuG;
  failure?: string;
}

export interface GpuAttachment {
  // The adapter, or why the CPU is used.
  note: string;
  // Set when attached: where table pair finding spent its time.
  stats?: PairStats;
  // False once the module gave up on the GPU after a failed request.
  stillEnabled(): boolean;
  stop(): void;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Attaches the GPU if it exists and agrees with the CPU on a sample. Otherwise returns a
// detached result whose note explains why, and the module runs on the CPU.
export async function attachGpu(
  state: GpuWorkerState, M: GpuHost, prefix: string, test: SelfTestParams,
): Promise<GpuAttachment> {
  const enable = fn(M, prefix, "gpu_enable");
  enable(0);
  const detached = (note: string): GpuAttachment => ({ note, stillEnabled: () => false, stop: () => {} });
  if (state.failure) return detached(state.failure);
  try {
    if (!state.device || state.device.lost) {
      const device = await GpuG.create();
      if (!device) return detached("no WebGPU adapter");
      state.device = device;
    }
    const gpu = state.device;
    if (!(await selfTest(gpu, M, prefix, test))) {
      state.failure = "GPU self test failed";
      return detached(state.failure);
    }
    gpu.stats = { uploadMs: 0, gpuMs: 0, copyMs: 0, requests: 0 };
    const service = serve(gpu, M, prefix, (m) => console.warn(m));
    enable(1);
    return {
      note: gpu.adapterInfo || "GPU",
      stats: gpu.stats,
      stillEnabled: () => fn(M, prefix, "gpu_enabled")() !== 0,
      stop: () => {
        enable(0);
        service.stop();
      },
    };
  } catch (e) {
    state.failure = `GPU unavailable: ${errorText(e)}`;
    return detached(state.failure);
  }
}
