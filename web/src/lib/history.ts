// The Finished plots table.

import { checksText, proofCount, reportPill } from "./checks-ui";
import { $ } from "./dom";
import { fmtBytes, fmtMs } from "./format";
import type { Timings } from "./protocol";
import type { Report } from "./validate";

export interface GroupInfo {
  strength: number;
  groupId: string;
  index: number;
  // Plots in this batch's group, or 0 when adding to an existing group or drive.
  size: number;
  metaGroup: number;
}

export interface HistoryRow {
  // The download link, for plots kept in browser storage.
  link: HTMLAnchorElement | null;
  setCheck(html: string): void;
  showReport(r: Report): void;
}

const PHASE_NAMES = ["hash", "sort", "pairs", "post sort", "misc"];

export class History {
  private body = $<HTMLTableSectionElement>("#history tbody");
  private count = 0;
  private bytes = 0;

  add(filename: string, bytes: number, t: Timings, group: GroupInfo, file?: File): HistoryRow {
    this.count++;
    this.bytes += bytes;
    $<HTMLElement>("#history-empty").hidden = true;
    $<HTMLElement>("#history-wrap").hidden = false;
    $<HTMLElement>("#history-summary").textContent =
      `${this.count} plot${this.count === 1 ? "" : "s"} · ${fmtBytes(this.bytes)}`;

    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="file"><div class="name"></div><div class="mt-1 text-xs text-muted where"></div></td>` +
      `<td class="group"></td><td class="num"></td>` +
      `<td class="num"><div class="total"></div><div class="text-xs text-muted split"></div></td>` +
      `<td class="gpu"></td><td class="check"><span class="pill pill-muted">not checked</span></td>`;
    // Plot IDs are long, so show the start and end and keep the full name on hover.
    const name = $<HTMLElement>(".name", tr);
    const m = filename.match(/^(plot-k\d+-)([0-9a-f]{64})(\.plot2)$/);
    name.textContent = m ? `${m[1]}${m[2].slice(0, 8)}…${m[2].slice(-4)}${m[3]}` : filename;
    name.title = filename;
    tr.cells[2].textContent = fmtBytes(bytes);
    $(".total", tr).textContent = fmtMs(t.totalMs);
    $(".split", tr).textContent = `plot ${fmtMs(t.plotMs)} · write ${fmtMs(t.writeMs)}`;

    const groupCell = $<HTMLElement>(".group", tr);
    const ofSize = group.size ? `/${group.size}` : "";
    groupCell.textContent = `s${group.strength} ${group.groupId.slice(0, 8)} #${group.index + 1}${ofSize} m${group.metaGroup}`;
    groupCell.title =
      `Strength ${group.strength}\nPlot group ID ${group.groupId}\nPlot index ${group.index}` +
      `${group.size ? ` (plot ${group.index + 1} of ${group.size} in this batch)` : ", added to an existing group"}\nMeta group ${group.metaGroup}`;
    tr.cells[3].title = ["Xs", "T1", "T2", "T3"]
      .map((n, i) => `${n} ${fmtMs(t.tablesMs[i])}: ` + t.phasesMs[i].map((ms, p) => (ms ? `${PHASE_NAMES[p]} ${fmtMs(ms)}` : "")).filter(Boolean).join(", "))
      .join("\n");
    const gpuCell = $<HTMLElement>(".gpu", tr);
    gpuCell.innerHTML = t.gpuMs > 0 ? `<span class="pill pill-ok">GPU</span>` : `<span class="pill pill-muted">CPU</span>`;
    gpuCell.title = t.gpuMs > 0 ? `${t.gpuNote}, ${fmtMs(t.gpuMs)} of GPU work` : t.gpuNote || "CPU";

    let link: HTMLAnchorElement | null = null;
    const where = $<HTMLElement>(".where", tr);
    if (file) {
      link = document.createElement("a");
      link.href = URL.createObjectURL(file);
      link.download = filename;
      link.textContent = "Download";
      where.append(link);
      link.click();
    } else {
      where.textContent = "Saved to folder";
    }
    this.body.prepend(tr);
    const checkCell = $<HTMLElement>(".check", tr);
    return {
      link,
      setCheck: (html) => (checkCell.innerHTML = html),
      showReport: (r) => {
        const proofs = r.checks.find((c) => c.name === "Proofs");
        const count = proofCount(proofs);
        const label = count ? `${count} proofs` : proofs?.detail.startsWith("no proofs") ? "no proofs" : "failed";
        checkCell.innerHTML = reportPill(r, label);
        checkCell.title = checksText(r);
      },
    };
  }
}
