// How check results look: a mark per check, and a pill for a whole report.

import type { Check, Report } from "./validate";

export const markOf = (c: Pick<Check, "ok" | "warn">) => (c.ok ? "✓" : c.warn ? "!" : "✗");

const markClass = (c: Pick<Check, "ok" | "warn">) => (c.ok ? "ok" : c.warn ? "warn" : "fail");

export const markHtml = (c?: Check) => (c ? `<span class="${markClass(c)}">${markOf(c)}</span>` : "");

// Every check on its own line, for a tooltip.
export const checksText = (r: Report) => r.checks.map((c) => `${markOf(c)} ${c.name}: ${c.detail}`).join("\n");

// "5/10" from a Proofs detail like "5 of 10 proofs valid…".
export const proofCount = (c?: Check) => c?.detail.match(/^(\d+) of (\d+)/)?.slice(1, 3).join("/") ?? "";

// A pill summarizing a report: failed, valid with warnings, or valid.
export function reportPill(r: Report, label: string): string {
  const warned = r.checks.some((c) => !c.ok && c.warn);
  const [cls, mark] = !r.ok ? ["pill-fail", "✗"] : warned ? ["pill-warn", "!"] : ["pill-ok", "✓"];
  return `<span class="pill ${cls}">${mark} ${label}</span>`;
}
