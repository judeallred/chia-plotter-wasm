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
  network?: Network;
  farmerKey?: string;
  pool?: string;
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

export class Validator {
  private worker = new Worker(new URL("./validator.worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private handlers = new Map<number, (m: FromValidator) => void>();

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<FromValidator>) => this.handlers.get(ev.data.id)?.(ev.data);
  }

  check(
    file: File,
    opts: { challenges: number; network: Network | "auto"; expectFarmerKey?: string },
    onProgress?: (p: Progress) => void,
  ): Promise<Report> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const checks: Check[] = [];
      let header: PlotHeader | undefined;
      let farmerKey: string | undefined;
      let pool: string | undefined;
      this.handlers.set(id, (m) => {
        if (m.type === "header") {
          header = m.header;
          const idHex = hex(header.plotId);
          const nameOk = file.name === `plot-k${header.k}-${idHex}.plot2`;
          checks.push({
            name: "File name",
            ok: nameOk,
            warn: true,
            detail: nameOk ? "matches the plot ID" : `expected plot-k${header.k}-${idHex}.plot2`,
          });
        } else if (m.type === "progress") {
          onProgress?.(m);
        } else if (m.type === "result") {
          this.handlers.delete(id);
          if (header) {
            const prefix = m.network === "testnet" ? "txch" : "xch";
            try {
              const info = inspect_memo(header.memo, header.strength, header.index, header.metaGroup, prefix);
              farmerKey = info.farmer_public_key;
              pool = info.pool_contract_address || info.pool_public_key;
              const idOk = info.plot_id_hex === hex(header.plotId);
              checks.push({
                name: "Keys",
                ok: idOk,
                detail: idOk
                  ? "memo keys produce this plot ID"
                  : "the keys in the memo do not produce this plot ID, so the plot cannot be farmed",
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
            let detail = `${m.valid} of ${m.found} proofs valid over ${m.challenges} challenges (${m.network})`;
            if (m.found === 0) detail = `no proofs found in ${m.challenges} challenges`;
            checks.push({ name: "Proofs", ok, detail });
          }
          resolve({
            file: file.name,
            ok: checks.every((c) => c.ok || c.warn),
            header,
            network: m.network,
            farmerKey,
            pool,
            checks,
            ms: m.ms,
          });
        }
      });
      this.worker.postMessage({ type: "validate", id, file, challenges: opts.challenges, network: opts.network });
    });
  }
}
