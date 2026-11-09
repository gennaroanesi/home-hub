"use client";

// Small layout pieces for the tax outlook page.

import React from "react";
import { Card, CardBody, CardHeader } from "@heroui/card";

export function StatRow({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "warn" | "bad" }) {
  const color = tone === "good" ? "text-success-600" : tone === "warn" ? "text-warning-600" : tone === "bad" ? "text-danger-600" : "";
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-default-500">
        {label}
        {hint && <span className="ml-1 text-xs text-default-400">{hint}</span>}
      </span>
      <span className={`tabular-nums font-medium ${color}`}>{value}</span>
    </div>
  );
}

export function TaxCard({ title, subtitle, children, className = "" }: { title: string; subtitle?: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader className="flex items-baseline justify-between gap-2 pb-1">
        <span className="text-xs uppercase tracking-wide font-semibold text-default-500">{title}</span>
        {subtitle && <span className="text-xs text-default-400">{subtitle}</span>}
      </CardHeader>
      <CardBody className="pt-0 gap-1.5">{children}</CardBody>
    </Card>
  );
}

export function Divider() {
  return <div className="border-t border-default-200 my-1" />;
}

export const nativeSelectCls = "rounded-medium border-2 border-default-200 bg-default-100 text-sm px-2 h-8 text-foreground";
