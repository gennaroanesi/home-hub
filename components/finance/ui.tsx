"use client";

// Small shared pieces for the finance pages.

import React from "react";
import { Chip } from "@heroui/chip";
import { Progress } from "@heroui/react";

import { fmtCurrency } from "@/lib/finance/dates";

/** A signed amount: green for money in, default for money out. */
export function Money({ value, sign = false, cents = true, className = "" }: { value: number | null | undefined; sign?: boolean; cents?: boolean; className?: string }) {
  const color = value != null && value > 0 && sign ? "text-success-600" : "";
  return <span className={`tabular-nums ${color} ${className}`}>{fmtCurrency(value, { sign, cents })}</span>;
}

export type PersonLite = { id: string; name: string; color?: string | null; emoji?: string | null };

/** A household member's name with their color, or "Household" when null. */
export function PersonChip({ personId, people, size = "sm" }: { personId?: string | null; people: PersonLite[]; size?: "sm" | "md" }) {
  const p = personId ? people.find((x) => x.id === personId) : null;
  if (!p) return <Chip size={size} variant="flat">Household</Chip>;
  return (
    <Chip size={size} variant="flat" style={p.color ? { backgroundColor: `${p.color}33`, color: p.color } : undefined}>
      {p.emoji ? `${p.emoji} ` : ""}
      {p.name}
    </Chip>
  );
}

/** Spent against budgeted; turns warning past pace and danger past 100%. */
export function BudgetBar({ spent, budgeted, elapsed, income = false }: { spent: number; budgeted: number; elapsed?: number; income?: boolean }) {
  const pct = budgeted > 0 ? (spent / budgeted) * 100 : spent > 0 ? 100 : 0;
  let color: "success" | "warning" | "danger" | "primary" = "primary";
  if (income) color = pct >= 100 ? "success" : "primary";
  else if (pct > 100) color = "danger";
  else if (elapsed != null && pct / 100 > elapsed + 0.05) color = "warning";
  else color = "success";
  return <Progress aria-label="Spent of budget" size="sm" value={Math.min(100, pct)} color={color} className="w-full" />;
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="text-center py-12 text-default-500">
      <p className="font-medium text-foreground">{title}</p>
      {children && <div className="text-sm mt-1">{children}</div>}
    </div>
  );
}

/** "updated 3h ago" from an ISO datetime. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
