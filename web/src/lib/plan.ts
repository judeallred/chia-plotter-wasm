// Which plot comes next: its keys, plot index, meta group and strength, for each plot
// grouping mode.

import type { ContinueGroup, DriveKey } from "./existing-plots";
import type { GroupInfo } from "./history";
import { type DerivedPlot, derive, derive_from_memo } from "./keys-pkg/plot_keys.js";
import type { Settings } from "./settings";

export interface PlannedPlot {
  derived: DerivedPlot;
  group: GroupInfo;
}

// Plots for one run, until the count is reached or the group runs out of plot indexes.
// The generator's return value says why it stopped early, if it did. Plot seeds are wiped
// when it finishes, however that happens.
export function* planPlots(
  s: Settings, existing: { group: ContinueGroup | null; drive: DriveKey | null; firstIndex: number },
): Generator<PlannedPlot, string | undefined> {
  const pool = [s.poolMode === "pk" ? s.poolKey : "", s.poolMode === "contract" ? s.poolAddress : ""] as const;
  const newPlot = (seed: Uint8Array, strength: number, index: number, meta: number) =>
    derive(seed, s.farmerKey, pool[0], pool[1], strength, index, meta);
  const seeds: Uint8Array[] = [];
  const newSeed = () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    seeds.push(seed);
    return seed;
  };
  const count = (i: number) => s.count === 0 || i < s.count;
  try {
    if (s.groupKeys === "drive") return yield* planDrive(s, existing.drive, newSeed, newPlot, count);
    if (s.groupKeys === "continue" && existing.group) return yield* planContinue(existing.group, existing.firstIndex, count);
    return yield* planNewGroups(s, newSeed, newPlot, count);
  } finally {
    for (const seed of seeds) seed.fill(0);
  }
}

type NewPlot = (seed: Uint8Array, strength: number, index: number, meta: number) => DerivedPlot;

// The hard drive layout: one plot key per drive, plots spread evenly over its meta groups.
function* planDrive(
  s: Settings, existingDrive: DriveKey | null, newSeed: () => Uint8Array, newPlot: NewPlot, count: (i: number) => boolean,
): Generator<PlannedPlot, string | undefined> {
  const continuing = s.driveStart === "continue" && existingDrive !== null;
  const drive: DriveKey = continuing
    ? existingDrive
    : { memo: new Uint8Array(), strength: s.strength, groupId: "", farmerKey: s.farmerKey, pool: "", metas: new Map(), plots: 0 };
  const seed = continuing ? null : newSeed();
  const metas = Math.max(1, Math.min(256, s.driveMetas || 16));
  // When continuing, start every meta group above the highest index seen on the drive. If
  // only some of the drive's plots were chosen, a meta group may have plots the page cannot
  // see, and indexes are plentiful, so skipping ahead is the safe choice.
  const floor = continuing ? Math.max(-1, ...[...drive.metas.values()].map((m) => m.maxIndex)) : -1;
  for (let i = 0; count(i); i++) {
    // Fill the emptiest meta group first, so groups stay even as the drive fills.
    let best = 0;
    for (let m = 1; m < metas; m++) {
      if ((drive.metas.get(m)?.count ?? 0) < (drive.metas.get(best)?.count ?? 0)) best = m;
    }
    const slot = drive.metas.get(best) ?? { count: 0, maxIndex: -1 };
    if (slot.maxIndex >= 65535) return "This drive's meta groups have no free plot indexes left.";
    const index = Math.max(slot.maxIndex, floor) + 1;
    const derived = seed ? newPlot(seed, drive.strength, index, best) : derive_from_memo(drive.memo, drive.strength, index, best);
    slot.count++;
    slot.maxIndex = index;
    drive.metas.set(best, slot);
    drive.plots++;
    yield { derived, group: { strength: drive.strength, groupId: derived.plot_group_id_hex, index, size: 0, metaGroup: best } };
  }
  return undefined;
}

// More plots in an existing group, at the next free indexes from firstIndex.
function* planContinue(
  group: ContinueGroup, firstIndex: number, count: (i: number) => boolean,
): Generator<PlannedPlot, string | undefined> {
  let index = Math.max(0, firstIndex);
  for (let i = 0; count(i); i++) {
    while (group.used.has(index)) index++;
    if (index > 65535) return "This group has no free plot indexes left.";
    const derived = derive_from_memo(group.memo, group.strength, index, group.metaGroup);
    group.used.add(index);
    group.plots++;
    yield { derived, group: { strength: group.strength, groupId: derived.plot_group_id_hex, index, size: 0, metaGroup: group.metaGroup } };
  }
  return undefined;
}

// A plot group is plots with the same plot key (one seed) and meta group, with indexes
// 0..groupSize-1. Independent groups each get a new key. Staggered groups share a key and
// step the meta group by 16, so no two of them pass the filter in the same window; after
// 16 groups the meta groups would repeat, so a new key starts. Without groups every plot
// is a group of one with meta group 0, like chia plots create2.
function* planNewGroups(
  s: Settings, newSeed: () => Uint8Array, newPlot: NewPlot, count: (i: number) => boolean,
): Generator<PlannedPlot, string | undefined> {
  const groupsPerKey = s.groupKeys === "shared" ? 16 : 1;
  const groupSize = s.groupKeys === "none" ? 1 : s.groupSize;
  const firstMeta = s.groupKeys === "none" ? 0 : s.metaGroup;
  let seed: Uint8Array = new Uint8Array(32);
  for (let i = 0; count(i); i++) {
    const index = i % groupSize;
    const groupInKey = Math.floor(i / groupSize) % groupsPerKey;
    if (index === 0 && groupInKey === 0) seed = newSeed();
    const metaGroup = (firstMeta + 16 * groupInKey) % 256;
    const derived = newPlot(seed, s.strength, index, metaGroup);
    yield { derived, group: { strength: s.strength, groupId: derived.plot_group_id_hex, index, size: groupSize, metaGroup } };
  }
  return undefined;
}
