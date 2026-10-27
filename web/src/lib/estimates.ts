// The estimates shown under the settings: how often plots and groups pass the filter, how
// much a drive must serve, and the plot groups explainer's numbers, which all follow the
// Drive size field.

import { $ } from "./dom";
import { fmtInterval, fmtRate } from "./format";
import { type Capabilities, K_SIZES, type Settings, drivePlotsOf, fmtTB, readSettings } from "./settings";

// Today's consensus constants: 64 signage points per 600 s sub slot (9,216 a day, one every
// 9.375 s), and filter bits min(9 + strength - 2, 13).
const SIGNAGE_POINTS_PER_DAY = 9216;
const SIGNAGE_POINT_SECONDS = 9.375;
// Random reads per plot lookup in this format, and what a typical hard drive manages.
const READS_PER_LOOKUP = 4;
const DRIVE_READS_PER_SECOND = 150;
// About this many plots per meta group is near what one drive serves in a signage point.
const PLOTS_PER_META_GROUP = 250;
// Above this many plots per signage point, the drive rate warns.
const TOO_MANY_PER_SIGNAGE_POINT = 300;

export const filterBits = (strength: number) => Math.min(9 + strength - 2, 13);
export const passesPerDay = (strength: number) => SIGNAGE_POINTS_PER_DAY / 2 ** filterBits(strength);
const intervalAt = (strength: number) => fmtInterval((24 * 60) / passesPerDay(strength));
const validStrength = (st: number | null): st is number => st !== null && st >= 2 && st <= 17;

function readRateText(s: Settings): string {
  if (!validStrength(s.strength)) return "";
  const bits = filterBits(s.strength);
  const perDay = passesPerDay(s.strength);
  const drivePlots = drivePlotsOf(s);
  const perSp = drivePlots / 2 ** bits;
  const capped = s.strength > 6 ? " Above strength 6 the filter is capped today, so this is the same as strength 6." : "";
  const drive =
    perSp >= 1
      ? `about ${fmtRate(perSp)} of them to read at every signage point (every 9.4 s)`
      : `one of them to read about every ${Math.round(SIGNAGE_POINT_SECONDS / perSp)} s`;
  return (
    `Strength ${s.strength} plots will wake about every ${intervalAt(s.strength)}, about ${fmtRate(perDay)} times a day ` +
    `(it passes 1 in ${(2 ** bits).toLocaleString()} signage points). A group wakes on the same schedule as one plot. ` +
    `A ${fmtTB(s.driveTB)} drive of ${drivePlots.toLocaleString()} ungrouped k28 plots has ${drive}.${capped}`
  );
}

function groupRateText(s: Settings, strength: number): string {
  const perDay = passesPerDay(strength);
  return (
    `At strength ${strength}, each group will be read about every ${intervalAt(strength)} (about ${fmtRate(perDay)} times a day), ` +
    `so a drive holding one group can sleep between reads if its spin-down timer is shorter than that.` +
    (strength <= 3
      ? ` That is still about ${Math.round(perDay)} spin-ups a day. If fewer spin-ups matter, use strength 4 to 6: ` +
        `strength 4 is about every ${intervalAt(4)}, strength 6 about every ${intervalAt(6)}, with slower plotting and proving.`
      : "") +
    (s.groupKeys === "continue" ? " Strength comes from the existing group." : "")
  );
}

function driveRateText(s: Settings, strength: number, fromDrive: boolean): { text: string; low: boolean } {
  const metas = Math.max(1, Math.min(256, s.driveMetas || 16));
  const blocks = Math.ceil(metas / 16);
  // Each block of 16 meta groups passes in the same windows; different blocks never share one.
  const wakesPerDay = passesPerDay(strength) * blocks;
  const perSp = Math.ceil(drivePlotsOf(s) / metas);
  const reads = perSp * READS_PER_LOOKUP;
  const tooMany = perSp > TOO_MANY_PER_SIGNAGE_POINT;
  return {
    low: strength <= 3 || tooMany,
    text:
      `At strength ${strength}, the drive wakes about every ${fmtInterval((24 * 60) / wakesPerDay)} (${fmtRate(wakesPerDay)} times a day) ` +
      `for ${blocks === 1 ? "one window" : `${blocks} windows`} of about 2.5 minutes, serving about ${perSp} plots at each signage point ` +
      `(about ${reads} random reads, roughly ${(reads / DRIVE_READS_PER_SECOND).toFixed(0)} s on a typical hard drive).` +
      (tooMany ? " That is a lot for one signage point, consider more meta groups." : "") +
      (strength <= 3 ? " Strength 4 to 6 means far fewer wakeups." : "") +
      (fromDrive ? " Strength comes from the drive's existing plots." : ""),
  };
}

// The explainer's drive numbers (elements with js-drive-* classes).
function syncExplainer(form: HTMLFormElement, s: Settings) {
  const n = drivePlotsOf(s);
  const tb = fmtTB(s.driveTB);
  const set = (cls: string, text: string) => form.querySelectorAll(`.${cls}`).forEach((el) => (el.textContent = text));
  set("js-drive-fits", `A ${tb} drive holds about ${n.toLocaleString()} k28 plots.`);
  set("js-drive-tb", tb);
  set("js-drive-plots", n.toLocaleString());
  const ungrouped = n / 2 ** filterBits(2);
  set("js-drive-ungrouped", ungrouped >= 1
    ? `about ${fmtRate(ungrouped)} of them pass at every signage point`
    : `one of them passes about every ${Math.round(SIGNAGE_POINT_SECONDS / ungrouped)} seconds`);
  const reads = n * READS_PER_LOOKUP;
  const secs = reads / DRIVE_READS_PER_SECOND;
  set("js-drive-one-group", `A whole ${tb} drive as one group (about ${n.toLocaleString()} plots, ${reads.toLocaleString()} reads at once) ` +
    (secs > 8 ? `is too much, about ${Math.round(secs)} seconds of reads.` : `takes about ${Math.max(1, Math.round(secs))} seconds of reads, which one drive can manage.`));
  set("js-drive-per-meta", Math.ceil(n / 16).toLocaleString());
  const metas = Math.min(256, 16 * Math.max(1, Math.ceil(n / (16 * PLOTS_PER_META_GROUP))));
  const blocks = metas / 16;
  set("js-drive-metas", `${metas} meta groups`);
  set("js-drive-wakes", blocks === 1 ? "once a day for one window" : `${blocks} times a day, one window each`);
  set("js-drive-per-meta-rec", Math.ceil(n / metas).toLocaleString());
  set("js-drive-sps", String(metas));
}

// Keeps every estimate in step with the form. The strengths of an existing group or drive,
// when adding to one, come from the callbacks. Call refresh() when those change.
export function setupEstimates(
  form: HTMLFormElement, caps: Capabilities, existing: { groupStrength(): number | null; driveStrength(): number | null },
) {
  const readRate = $<HTMLElement>("#read-rate");
  const groupRate = $<HTMLElement>("#group-rate");
  const driveRate = $<HTMLElement>("#drive-rate");
  const kDetails = $<HTMLElement>("#k-details");
  const refresh = () => {
    const s = readSettings(form);
    syncExplainer(form, s);
    readRate.textContent = readRateText(s);

    const groupStrength = s.groupKeys === "continue" ? existing.groupStrength() : s.strength;
    const showGroup = s.groupKeys !== "none" && validStrength(groupStrength);
    groupRate.textContent = showGroup ? groupRateText(s, groupStrength) : "";
    groupRate.classList.toggle("low", showGroup && groupStrength <= 3);

    const fromDrive = s.driveStart === "continue" ? existing.driveStrength() : null;
    const drive = driveRateText(s, fromDrive ?? s.strength, fromDrive !== null);
    driveRate.textContent = drive.text;
    driveRate.classList.toggle("low", drive.low);

    const size = K_SIZES[s.k];
    kDetails.textContent = size
      ? `Each k${s.k} plot is ${size.file} on disk, needs ${size.memory} of memory while plotting, and takes ${size.gpu} at strength 2 on a fast laptop with the GPU (${size.cpu} on the CPU only).` +
        (s.k >= 28 && !caps.memory64 ? " This browser lacks WebAssembly memory64, which k28 needs." : "")
      : "";
  };
  form.addEventListener("input", refresh);
  form.addEventListener("change", refresh);
  refresh();
  return { refresh };
}
