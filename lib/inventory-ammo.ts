// Ammo bookkeeping (docs/inventory-specialized.md): one item per purchase
// ("lot") with its rounds on hand; logging use takes from the oldest lots
// first; totals and minimums go by caliber. Pure, shared by the ops and
// the pages.

export interface AmmoLot {
  itemId: string;
  caliber: string;
  roundsAvailable: number | null | undefined;
  acquiredAt?: string | null; // the item's
  createdAt?: string | null;
  status?: string | null; // the item's; only OWNED lots count
}

/** "9mm Luger " → "9mm luger": how calibers are compared. Display keeps the spelling used. */
export function caliberKey(caliber: string | null | undefined): string {
  return (caliber ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

const owned = (l: AmmoLot) => !l.status || l.status === "OWNED";

/** Oldest first: by purchase date, then when it was entered. */
export function lotsOldestFirst<L extends AmmoLot>(lots: L[]): L[] {
  return [...lots].sort((a, b) => (a.acquiredAt ?? "9999").localeCompare(b.acquiredAt ?? "9999") || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

export interface AmmoDraw {
  draws: Array<{ itemId: string; rounds: number }>;
  /** Rounds that couldn't be taken from any lot (logged more than was on hand). */
  shortfall: number;
}

/** Which lots `rounds` of a caliber come out of, oldest first. Only from lots with rounds on hand. */
export function planAmmoUse(lots: AmmoLot[], caliber: string, rounds: number): AmmoDraw {
  const key = caliberKey(caliber);
  let left = Math.max(0, Math.floor(rounds));
  const draws: AmmoDraw["draws"] = [];
  for (const lot of lotsOldestFirst(lots.filter((l) => owned(l) && caliberKey(l.caliber) === key && (l.roundsAvailable ?? 0) > 0))) {
    if (left === 0) break;
    const take = Math.min(left, lot.roundsAvailable ?? 0);
    draws.push({ itemId: lot.itemId, rounds: take });
    left -= take;
  }
  return { draws, shortfall: left };
}

export interface CaliberTotal {
  caliber: string; // as most recently spelled
  rounds: number;
  lots: number; // lots with rounds left
  minRounds: number | null;
  below: boolean;
}

/** Rounds on hand per caliber, with each caliber's minimum when one is set. */
export function caliberTotals(lots: AmmoLot[], thresholds: Array<{ caliber: string; minRounds: number; enabled?: boolean | null }> = []): CaliberTotal[] {
  const byKey = new Map<string, CaliberTotal>();
  for (const l of lotsOldestFirst(lots.filter(owned))) {
    const key = caliberKey(l.caliber);
    if (!key) continue;
    const t = byKey.get(key) ?? { caliber: l.caliber.trim(), rounds: 0, lots: 0, minRounds: null, below: false };
    t.caliber = l.caliber.trim();
    t.rounds += Math.max(0, l.roundsAvailable ?? 0);
    if ((l.roundsAvailable ?? 0) > 0) t.lots += 1;
    byKey.set(key, t);
  }
  for (const th of thresholds) {
    if (th.enabled === false) continue;
    const key = caliberKey(th.caliber);
    const t = byKey.get(key) ?? { caliber: th.caliber.trim(), rounds: 0, lots: 0, minRounds: null, below: false };
    t.minRounds = th.minRounds;
    byKey.set(key, t);
  }
  for (const t of byKey.values()) t.below = t.minRounds != null && t.rounds < t.minRounds;
  return [...byKey.values()].sort((a, b) => a.caliber.localeCompare(b.caliber));
}

/**
 * Which minimums to alert on and which to re-arm, given the totals: alert
 * once when a caliber drops below its minimum (notifiedAt unset), clear
 * notifiedAt once it's back at or above.
 */
export function thresholdChanges<T extends { id: string; caliber: string; minRounds: number; enabled?: boolean | null; notifiedAt?: string | null }>(
  thresholds: T[],
  totals: CaliberTotal[],
): { alert: Array<{ threshold: T; rounds: number }>; rearm: T[] } {
  const rounds = new Map(totals.map((t) => [caliberKey(t.caliber), t.rounds]));
  const alert: Array<{ threshold: T; rounds: number }> = [];
  const rearm: T[] = [];
  for (const th of thresholds) {
    if (th.enabled === false) continue;
    const have = rounds.get(caliberKey(th.caliber)) ?? 0;
    if (have < th.minRounds && !th.notifiedAt) alert.push({ threshold: th, rounds: have });
    else if (have >= th.minRounds && th.notifiedAt) rearm.push(th);
  }
  return { alert, rearm };
}
