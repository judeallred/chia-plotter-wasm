// Messages between the page and the plotter worker.

export type Sink =
  // Write into a folder the user picked with the File System Access API.
  | { kind: "dir"; dir: FileSystemDirectoryHandle }
  // Write into the origin private file system, then hand the File back for download.
  | { kind: "opfs" };

export interface PlotJob {
  k: number;
  strength: number;
  plotId: Uint8Array;
  memo: Uint8Array;
  testnet: boolean;
  threads: number;
  filename: string;
  sink: Sink;
}

export type ToWorker =
  | { type: "plot"; job: PlotJob }
  | { type: "cancel" };

export interface Timings {
  totalMs: number;
  plotMs: number;
  writeMs: number;
  // Xs, table 1, table 2, table 3, as reported by the plotter.
  tablesMs: [number, number, number, number];
}

export type Phase = "loading" | "plotting" | "writing";

export type FromWorker =
  | { type: "progress"; phase: Phase; fraction: number; table: number; detail: string }
  | { type: "done"; filename: string; bytes: number; timings: Timings; file?: File }
  | { type: "cancelled" }
  | { type: "error"; message: string };
