// Savings goal progress. A goal either tracks a manual currentAmount or is
// funded by an account: each funding account's balance is allocated to its
// goals in priority order (lower first), each capped at its target, so two
// goals on the joint savings never count the same dollars.
// Simplified from gennaroanesi.com's computeGoalAllocations (one funding
// account per goal instead of a many-to-many mapping).

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

export function goalProgress(goals: GoalLike[], accounts: AccountLike[], todayIso: string): GoalProgress[] {
  const balance = new Map(accounts.map((a) => [a.id, Math.max(0, a.currentBalance ?? 0)]));
  const left = new Map(balance);
  const allocated = new Map<string, number>();
  const funded = goals
    .filter((g) => g.active !== false && g.fundingAccountId && balance.has(g.fundingAccountId))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.name.localeCompare(b.name));
  for (const g of funded) {
    const avail = left.get(g.fundingAccountId!) ?? 0;
    const take = Math.min(avail, Math.max(0, g.targetAmount ?? 0));
    allocated.set(g.id, take);
    left.set(g.fundingAccountId!, avail - take);
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
