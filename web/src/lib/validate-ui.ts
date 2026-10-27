// The Validate plots section: check plot files or a whole folder and show a row per plot.

import { checksText, markHtml, proofCount, reportPill } from "./checks-ui";
import { $, canPickDirectories, pickDirectory } from "./dom";
import { type FoundPlot, walkPlots } from "./existing-plots";
import { escapeHtml } from "./format";
import type { Settings } from "./settings";
import type { Validator } from "./validate";

export function setupValidateSection(validator: Validator, settings: () => Settings) {
  const input = $<HTMLInputElement>("#v-files");
  const dirBtn = $<HTMLButtonElement>("#v-dir");
  const tbody = $<HTMLTableSectionElement>("#v-results tbody");
  if (!canPickDirectories()) dirBtn.hidden = true;

  const run = (files: FoundPlot[]) => {
    const challenges = Math.max(1, Number($<HTMLInputElement>("#v-challenges").value) || 30);
    const network = $<HTMLSelectElement>("#v-network").value as "auto" | "mainnet" | "testnet";
    for (const { file, path } of files) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="file"></td>${"<td></td>".repeat(10)}<td><span class="pill pill-muted">queued</span></td>`;
      tr.cells[0].textContent = path;
      tbody.prepend(tr);
      const cell = (i: number, html: string, title = "") => {
        tr.cells[i].innerHTML = html;
        tr.cells[i].title = title;
      };
      const s = settings();
      void validator
        .check(file, { challenges, network, expectFarmerKey: s.farmerKey || undefined, gpu: s.gpu !== "off" }, (p) => {
          cell(6, `${p.valid}/${p.found} <small>${p.done}/${p.total}</small>`);
        })
        .then((r) => {
          const find = (name: string) => r.checks.find((c) => c.name === name);
          const h = r.header;
          cell(1, h ? String(h.k) : "");
          cell(2, h ? String(h.strength) : "");
          cell(3, r.groupId ? `<code>${escapeHtml(r.groupId.slice(0, 8))}</code>` : "", r.groupId ?? "");
          cell(4, h ? String(h.index) : "");
          cell(5, h ? String(h.metaGroup) : "");
          const proofs = find("Proofs") ?? find("Header");
          cell(6, `${markHtml(proofs)} ${proofCount(proofs)}`, proofs?.detail ?? "");
          cell(7, markHtml(find("Keys")), find("Keys")?.detail ?? "");
          cell(8, markHtml(find("File name")), find("File name")?.detail ?? "");
          const farmer = [find("Farmer key")?.detail, r.farmerKey && `farmer ${r.farmerKey}`, r.pool && `pool ${r.pool}`];
          cell(9, markHtml(find("Farmer key")), farmer.filter(Boolean).join("\n"));
          cell(10, `${(r.ms / 1000).toFixed(1)} s`);
          cell(11, reportPill(r, r.ok ? "valid" : "failed"), checksText(r));
        });
    }
  };

  input.addEventListener("change", () => {
    run(Array.from(input.files ?? [], (file) => ({ file, path: file.name })));
    input.value = "";
  });
  dirBtn.addEventListener("click", async () => {
    const dir = await pickDirectory("read");
    if (!dir) return;
    const files = await walkPlots(dir);
    files.sort((a, b) => a.path.localeCompare(b.path));
    run(files);
  });
}
