// Whose an invoice is, and who sees a private one. Shared by the web and
// phone Invoices screens, the invoice ops (Janet, the API, hh) and the
// invoice-processor. Pure.
//
// - ownerPersonIds: empty = the household's; otherwise those members'.
// - private: shown only to its owners. A flag the apps and ops honor, not a
//   database rule: both logins can still read the row through the raw data
//   API (unlike inventory's owner-only table). Never shown in a group chat.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type InvoiceOwned = { ownerPersonIds?: (string | null)[] | null; private?: boolean | null };

export function invoiceOwnerIds(inv: InvoiceOwned): string[] {
  return (inv.ownerPersonIds ?? []).filter((x): x is string => !!x);
}

/**
 * Whether `viewerPersonId` may see it: anyone for a non-private invoice;
 * only an owner for a private one (no viewer, e.g. a group chat, sees none).
 */
export function invoiceVisibleTo(inv: InvoiceOwned, viewerPersonId: string | null | undefined): boolean {
  if (!inv.private) return true;
  return !!viewerPersonId && invoiceOwnerIds(inv).includes(viewerPersonId);
}

/** The owner filter: "all", or a person's invoices plus the household's (like tasks and notes). */
export function invoiceOwnedBy(inv: InvoiceOwned, personId: string | null | undefined): boolean {
  if (!personId || personId === "all") return true;
  const owners = invoiceOwnerIds(inv);
  return owners.length === 0 || owners.includes(personId);
}

/** "Household", "Gennaro", "Gennaro and Cristine". */
export function invoiceOwnerLabel(inv: InvoiceOwned, people: { id: string; name: string }[]): string {
  const names = invoiceOwnerIds(inv)
    .map((id) => people.find((p) => p.id === id)?.name)
    .filter((x): x is string => !!x);
  if (!names.length) return "Household";
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Why owners + private can't be saved as given, or null. A private invoice needs an owner to be seen at all. */
export function invoiceOwnerError(ownerPersonIds: string[], isPrivate: boolean): string | null {
  return isPrivate && ownerPersonIds.length === 0 ? "A private invoice needs an owner: pick whose it is." : null;
}

/** The household member who sent an email (exact match on homePerson.email), for an emailed invoice's owner. */
export function personBySenderEmail<P extends { id: string; email?: string | null }>(from: string | null | undefined, people: P[]): P | null {
  const addr = (from ?? "").match(/[^\s<>]+@[^\s<>]+/)?.[0]?.toLowerCase();
  if (!addr) return null;
  return people.find((p) => (p.email ?? "").trim().toLowerCase() === addr) ?? null;
}
