// Savings goal progress. A goal either tracks a manual currentAmount or is
// funded by one or more accounts (the joint savings; both 401ks for a
// retirement goal). Goals are filled in priority order (lower first), each
// drawing on its accounts in the order listed and capped at its target, so
// two goals on the same account never count the same dollars.
// Simplified from gennaroanesi.com's computeGoalAllocations (an ordered
// account list per goal instead of a weighted many-to-many mapping).

import { daysBetween } from "./dates";
import type { AccountLike, GoalLike } from "./types";

export type GoalProgress = {
  goal: GoalLike;
  current: number;
  target: number;
  pct: number; // 0..1
  /** Monthly saving needed to hit the target by targetDate; null without a date or when met. */
  monthlyNeeded: number | null;
  funded: "manual" | "account";
};

export type MilestoneLike = { id: string; goalId: string; targetAmount: number; targetDate: string; label?: string | null; notes?: string | null };

export type MilestoneStatus = "HIT" | "MISSED" | "PENDING";

export type MilestoneView = {
  milestone: MilestoneLike;
  status: MilestoneStatus;
  /** Only on the next pending milestone: monthly saving needed to reach it by its date. */
  monthlyNeeded: number | null;
};

/**
 * A goal's milestones by date, each HIT (progress reached its amount),
 * MISSED (its date passed first) or PENDING. Status is live, as in
 * gennaroanesi.com: a goal on a 401k can drop back below a milestone it hit.
 */
export function milestoneViews(milestones: MilestoneLike[], current: number, todayIso: string): MilestoneView[] {
  const sorted = [...milestones].sort((a, b) => a.targetDate.localeCompare(b.targetDate) || a.targetAmount - b.targetAmount);
  let nextSeen = false;
  return sorted.map((m) => {
    const status: MilestoneStatus = current >= m.targetAmount ? "HIT" : todayIso > m.targetDate ? "MISSED" : "PENDING";
    let monthlyNeeded: number | null = null;
    if (status === "PENDING" && !nextSeen) {
      nextSeen = true;
      // Under a month left: the whole gap is due now.
      monthlyNeeded = (m.targetAmount - current) / Math.max(1, daysBetween(todayIso, m.targetDate) / 30.44);
    }
    return { milestone: m, status, monthlyNeeded };
  });
}

/** The accounts a goal draws on: fundingAccountIds, else the older single fundingAccountId. */
export function goalAccountIds(goal: Pick<GoalLike, "fundingAccountId" | "fundingAccountIds">): string[] {
  const ids = (goal.fundingAccountIds ?? []).filter((x): x is string => !!x);
  if (!ids.length && goal.fundingAccountId) ids.push(goal.fundingAccountId);
  return [...new Set(ids)];
}

export function goalProgress(goals: GoalLike[], accounts: AccountLike[], todayIso: string): GoalProgress[] {
  const left = new Map(accounts.map((a) => [a.id, Math.max(0, a.currentBalance ?? 0)]));
  const allocated = new Map<string, number>();
  const funded = goals
    .filter((g) => g.active !== false && goalAccountIds(g).some((id) => left.has(id)))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.name.localeCompare(b.name));
  for (const g of funded) {
    let need = Math.max(0, g.targetAmount ?? 0);
    let took = 0;
    for (const id of goalAccountIds(g)) {
      if (need <= 0) break;
      const avail = left.get(id);
      if (avail == null) continue;
      const take = Math.min(avail, need);
      left.set(id, avail - take);
      need -= take;
      took += take;
    }
    allocated.set(g.id, took);
  }
  return goals.map((goal) => {
    const byAccount = allocated.has(goal.id);
    const current = byAccount ? allocated.get(goal.id)! : Math.max(0, goal.currentAmount ?? 0);
    const target = Math.max(0, goal.targetAmount ?? 0);
    const pct = target > 0 ? Math.min(1, current / target) : 0;
    let monthlyNeeded: number | null = null;
    if (goal.targetDate && current < target) {
      const months = daysBetween(todayIso, goal.targetDate) / 30.44;
      monthlyNeeded = months > 0 ? (target - current) / months : target - current;
    }
    return { goal, current, target, pct, monthlyNeeded, funded: byAccount ? "account" : "manual" };
  });
}
