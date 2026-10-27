// Messages between the page and the plotter worker.

export type Sink =
  // Write into a folder the user picked with the File System Access API.
  | { kind: "dir"; dir: FileSystemDirectoryHandle }
  // Write into the origin private file system, then hand the File back for download.
  | { kind: "opfs" };

export interface PlotJob {
  k: number;
  strength: number;
  // Position in the plot group and the group's meta group, stored in the plot header.
  plotIndex: number;
  metaGroup: number;
  plotId: Uint8Array;
  memo: Uint8Array;
  testnet: boolean;
  threads: number;
  // Use WebGPU for g(x) when available. The CPU is used if this is off or the GPU fails.
  gpu: boolean;
  filename: string;
  sink: Sink;
}

export type ToWorker =
  | { type: "plot"; job: PlotJob }
  | { type: "cancel" }
  | { type: "pause"; paused: boolean };

export interface Timings {
  totalMs: number;
  plotMs: number;
  writeMs: number;
  // Xs, table 1, table 2, table 3, as reported by the plotter.
  tablesMs: [number, number, number, number];
  // Time spent in GPU requests, 0 if the GPU was not used.
  gpuMs: number;
  // What ran g(x): the GPU adapter, or why the CPU was used.
  gpuNote: string;
  // [table][phase] ms: tables Xs, T1, T2, T3; phases hash, sort, find pairs, post sort, misc.
  phasesMs: number[][];
}

export type Phase = "loading" | "plotting" | "writing";

export type FromWorker =
  | { type: "progress"; phase: Phase; fraction: number; table: number; detail: string; heapBytes?: number }
  | { type: "done"; filename: string; bytes: number; timings: Timings; file?: File }
  | { type: "cancelled" }
  | { type: "error"; message: string };

// Messages between the page and the validator worker.

export type Network = "mainnet" | "testnet";

export interface PlotHeader {
  plotId: Uint8Array;
  k: number;
  strength: number;
  index: number;
  metaGroup: number;
  memo: Uint8Array;
}

export interface ValidateRequest {
  type: "validate";
  id: number;
  file: File;
  challenges: number;
  // "auto" tries mainnet first and switches to testnet if mainnet proofs do not validate.
  network: Network | "auto";
  gpu: boolean;
}

export type FromValidator =
  | { type: "header"; id: number; header: PlotHeader }
  | { type: "progress"; id: number; done: number; total: number; found: number; valid: number }
  | {
      type: "result";
      id: number;
      network: Network;
      challenges: number;
      found: number;
      solved: number;
      valid: number;
      ms: number;
      gpuNote: string;
      error?: string;
    };
