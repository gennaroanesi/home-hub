// Documents helpers — labels, type config, owner resolution.
//
// File upload + Duo-gated download stay separate (lib/documents-upload.ts
// handles the presign + S3 PUT round-trip). This file is metadata-only:
// label maps, sort comparator, expiration helpers used by the list and
// detail screens.

import type { Schema } from "../../amplify/data/resource";
import { type Person } from "./use-people";

export type Document = Schema["homeDocument"]["type"];

export type DocumentType =
  | "ID"
  | "INSURANCE"
  | "TAX"
  | "MEDICAL"
  | "TRAVEL"
  | "FINANCIAL"
  | "OTHER";

export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  ID: "ID",
  INSURANCE: "Insurance",
  TAX: "Tax",
  MEDICAL: "Medical",
  TRAVEL: "Travel",
  FINANCIAL: "Financial",
  OTHER: "Other",
};

export const DOCUMENT_TYPE_EMOJI: Record<DocumentType, string> = {
  ID: "🪪",
  INSURANCE: "🛡️",
  TAX: "🧾",
  MEDICAL: "💊",
  TRAVEL: "✈️",
  FINANCIAL: "💰",
  OTHER: "📄",
};

/** All known document types in display order. */
export const DOCUMENT_TYPES: DocumentType[] = [
  "ID",
  "INSURANCE",
  "TAX",
  "MEDICAL",
  "TRAVEL",
  "FINANCIAL",
  "OTHER",
];

export function ownerLabel(doc: Document, people: Person[]): string {
  if (doc.scope === "HOUSEHOLD") return "Household";
  if (!doc.ownerPersonId) return "—";
  const p = people.find((x) => x.id === doc.ownerPersonId);
  return p?.name ?? "(unknown)";
}

/** Days until expiration. Negative means already expired; null when no
 *  expiration date is set. */
export function daysUntilExpiry(doc: Document): number | null {
  if (!doc.expiresDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(doc.expiresDate);
  if (!m) return null;
  const exp = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((exp.getTime() - today.getTime()) / (24 * 3600 * 1000));
}

/** Human-readable expiration label. */
export function expiryLabel(doc: Document): string | null {
  const days = daysUntilExpiry(doc);
  if (days == null) return null;
  if (days < 0) return `Expired ${-days}d ago`;
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  if (days <= 30) return `Expires in ${days}d`;
  if (days <= 180) {
    const months = Math.round(days / 30);
    return `Expires in ${months} mo`;
  }
  // Beyond 6 months: show absolute year.
  const m = /^(\d{4})/.exec(doc.expiresDate ?? "");
  return m ? `Expires ${m[1]}` : `Expires in ${days}d`;
}

/** Approaching-expiry cutoff so we can highlight rows in the list. */
export function isExpiringSoon(doc: Document): boolean {
  const days = daysUntilExpiry(doc);
  return days !== null && days <= 60;
}

/** Sort: expired/expiring soon first; then by expiration ascending;
 *  then by title. */
export function compareDocs(a: Document, b: Document): number {
  const aDays = daysUntilExpiry(a);
  const bDays = daysUntilExpiry(b);
  if (aDays != null && bDays != null) {
    if (aDays !== bDays) return aDays - bDays;
  } else if (aDays != null) {
    return -1;
  } else if (bDays != null) {
    return 1;
  }
  return a.title.localeCompare(b.title);
}
