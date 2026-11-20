// Page side of plot validation: sends files to the validator worker and turns the result
// into a list of named checks.

import { inspect_memo } from "./keys-pkg/plot_keys.js";
import type { FromValidator, Network, PlotHeader } from "./protocol";

export interface Check {
  name: string;
  ok: boolean;
  // Warnings are shown but do not fail the plot. A renamed plot still farms.
  warn?: boolean;
  detail: string;
}

export interface Report {
  file: string;
  ok: boolean;
  header?: PlotHeader;
  farmerKey?: string;
  pool?: string;
  // Plots with the same group ID pass the plot filter together.
  groupId?: string;
  checks: Check[];
  ms: number;
}

export interface Progress {
  done: number;
  total: number;
  found: number;
  valid: number;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// The name chia plots create2 gives a plot group file.
export const plotFileName = (k: number, groupIdHex: string) => `plot-k${k}-${groupIdHex}.gplot`;

export class Validator {
  private worker = this.makeWorker();
  private nextId = 1;
  private handlers = new Map<number, (m: FromValidator) => void>();

  // A crash (for example running out of memory on a k28 plot) fails every pending check, so
  // nothing waits forever, and the next check gets a fresh worker.
  private makeWorker(): Worker {
    const w = new Worker(new URL("./validator.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<FromValidator>) => this.handlers.get(ev.data.id)?.(ev.data);
    const crashed = (message: string) => {
      w.terminate();
      this.worker = this.makeWorker();
      for (const [id, handle] of [...this.handlers]) {
        handle({
          type: "result", id, challenges: 0, found: 0, solved: 0, valid: 0, ms: 0, gpuNote: "",
          error: `validator crashed: ${message}`,
        });
      }
    };
    w.onerror = (e) => {
      e.preventDefault();
      crashed(e.message || "unknown error");
    };
    w.onmessageerror = () => crashed("unreadable message");
    return w;
  }

  check(
    file: File,
    // network only picks the prefix the pool contract address is shown with.
    opts: { challenges: number; network: Network; expectFarmerKey?: string; gpu: boolean },
    onProgress?: (p: Progress) => void,
  ): Promise<Report> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const checks: Check[] = [];
      let header: PlotHeader | undefined;
      let farmerKey: string | undefined;
      let pool: string | undefined;
      let groupId: string | undefined;
      this.handlers.set(id, (m) => {
        if (m.type === "header") {
          header = m.header;
          const idHex = hex(header.plotGroupId);
          const expected = plotFileName(header.k, idHex);
          // chia plots create2 adds -<index> to the files of a group after the first.
          const nameOk = new RegExp(`^plot-k${header.k}-${idHex}(-\\d+)?\\.gplot$`).test(file.name);
          checks.push({
            name: "File name",
            ok: nameOk,
            warn: true,
            detail: nameOk ? "matches the plot group ID" : `expected ${expected}`,
          });
        } else if (m.type === "progress") {
          onProgress?.(m);
        } else if (m.type === "result") {
          this.handlers.delete(id);
          if (header) {
            const prefix = opts.network === "testnet" ? "txch" : "xch";
            try {
              const info = inspect_memo(header.memo, header.strength, 0, header.metaGroup, prefix);
              farmerKey = info.farmer_public_key;
              pool = info.pool_contract_address || info.pool_public_key;
              groupId = info.plot_group_id_hex;
              const idOk = info.plot_group_id_hex === hex(header.plotGroupId);
              checks.push({
                name: "Keys",
                ok: idOk,
                detail: idOk
                  ? "memo keys produce this plot group ID"
                  : "the keys in the memo do not produce this plot group ID, so the plot cannot be farmed",
              });
              info.free();
            } catch (e) {
              checks.push({ name: "Keys", ok: false, detail: `memo does not decode: ${e instanceof Error ? e.message : e}` });
            }
            if (opts.expectFarmerKey && farmerKey) {
              const same = farmerKey === opts.expectFarmerKey.trim().replace(/^0x/, "").toLowerCase();
              checks.push({
                name: "Farmer key",
                ok: same,
                warn: true,
                detail: same ? "matches the farmer key in your settings" : "differs from the farmer key in your settings",
              });
            }
          }
          if (m.error) {
            checks.push({ name: header ? "Proofs" : "Header", ok: false, detail: m.error });
          } else {
            const ok = m.found > 0 && m.valid === m.found;
            let detail = `${m.valid} of ${m.found} proofs valid over ${m.challenges} challenges (${m.gpuNote || "CPU"})`;
            // A plot finds about one proof per challenge, so a few challenges can find none by
            // chance. Only treat that as a failure once enough challenges have run.
            const fewChallenges = m.found === 0 && m.challenges < 30;
            if (m.found === 0) {
              detail = fewChallenges
                ? `no proofs in ${m.challenges} challenges, which can happen by chance. Check again with 30 or more.`
                : `no proofs found in ${m.challenges} challenges`;
            }
            checks.push({ name: "Proofs", ok, warn: fewChallenges, detail });
          }
          resolve({
            file: file.name,
            ok: checks.every((c) => c.ok || c.warn),
            header,
            farmerKey,
            pool,
            groupId,
            checks,
            ms: m.ms,
          });
        }
      });
      this.worker.postMessage({ type: "validate", id, file, challenges: opts.challenges, gpu: opts.gpu });
    });
  }
}
