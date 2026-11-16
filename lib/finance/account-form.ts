/**
 * account-form.ts — the add / edit finance account form, shared by the web
 * (pages/finance/accounts.tsx) and the phone (mobile AccountFormModal): the
 * form shape, filling it from a homeFinanceAccount row, validation, the row
 * written to homeFinanceAccount, the SimpleFIN picker (listSimplefinAccounts
 * grouped by connection) and the delete guard. Writes go straight to the
 * model with any Amplify data client.
 */

import { listHoldings, txIndexQuery } from "./data";
import { DEFAULT_SIMPLEFIN_CONNECTION, SIMPLEFIN_CONNECTIONS } from "./simplefin-connections";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Client = any;

export type AccountForm = {
  id?: string;
  name: string;
  type: string;
  retirementType: string;
  institution: string;
  last4: string;
  currentBalance: string;
  ownerPersonIds: string[];
  active: boolean;
  sortOrder: string;
  minBalance: string;
  creditLimit: string;
  statementDueDay: string;
  /** Percent as typed (6.25); stored as a decimal (0.0625). */
  apr: string;
  apy: string;
  simplefinAccountId: string;
  simplefinConnection: string;
  notes: string;
};

export const EMPTY_ACCOUNT_FORM: AccountForm = {
  name: "",
  type: "CHECKING",
  retirementType: "_401K",
  institution: "",
  last4: "",
  currentBalance: "0",
  ownerPersonIds: [],
  active: true,
  sortOrder: "",
  minBalance: "",
  creditLimit: "",
  statementDueDay: "",
  apr: "",
  apy: "",
  simplefinAccountId: "",
  simplefinConnection: DEFAULT_SIMPLEFIN_CONNECTION,
  notes: "",
};

/** Which optional fields a type shows (and writes; hidden ones are written null). */
export const accountTypeFields = (type: string) => ({
  retirementType: type === "RETIREMENT",
  minBalance: type === "CHECKING" || type === "CASH",
  creditLimit: type === "CREDIT",
  statementDueDay: type === "CREDIT",
  apr: type === "CREDIT" || type === "LOAN",
  apy: type === "SAVINGS",
});

const str = (n: number | null | undefined) => (n == null ? "" : String(n));
const num = (s: string): number | null => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));
const pctIn = (n: number | null | undefined) => (n == null ? "" : String(Math.round(n * 10000) / 100));
const pctOut = (s: string) => {
  const n = num(s);
  return n == null ? null : n / 100;
};

/** A blank form for a new account, sorted after the existing ones. */
export function newAccountForm(existingCount: number): AccountForm {
  return { ...EMPTY_ACCOUNT_FORM, sortOrder: String((existingCount + 1) * 10) };
}

/** The form for editing an existing homeFinanceAccount row. */
export function accountFormFrom(a: any): AccountForm {
  return {
    id: a.id,
    name: a.name ?? "",
    type: a.type ?? "OTHER",
    retirementType: a.retirementType ?? "_401K",
    institution: a.institution ?? "",
    last4: a.last4 ?? "",
    currentBalance: str(a.currentBalance ?? 0),
    ownerPersonIds: (a.ownerPersonIds ?? []).filter(Boolean),
    active: a.active !== false,
    sortOrder: str(a.sortOrder),
    minBalance: str(a.minBalance),
    creditLimit: str(a.creditLimit),
    statementDueDay: str(a.statementDueDay),
    apr: pctIn(a.apr),
    apy: pctIn(a.apy),
    simplefinAccountId: a.simplefinAccountId ?? "",
    simplefinConnection: a.simplefinConnection ?? DEFAULT_SIMPLEFIN_CONNECTION,
    notes: a.notes ?? "",
  };
}

/** Why the form can't be saved, or null. `accounts` are all the household's account rows. */
export function validateAccountForm(form: AccountForm, accounts: Array<{ id: string; name: string; simplefinAccountId?: string | null }>): string | null {
  if (!form.name.trim()) return "Name is required";
  const due = num(form.statementDueDay);
  if (due != null && (due < 1 || due > 31)) return "Statement due day must be 1–31";
  const sfId = form.simplefinAccountId.trim() || null;
  const clash = sfId && accounts.find((a) => a.simplefinAccountId === sfId && a.id !== form.id);
  if (clash) return `That SimpleFIN account is already linked to ${clash.name}`;
  return null;
}

/**
 * The homeFinanceAccount fields to create / update with (no id). Fields the
 * type doesn't use are nulled; balanceUpdatedAt is stamped when the balance
 * is new or changed by at least half a cent.
 */
export function accountWriteRow(form: AccountForm, existing: { currentBalance?: number | null } | null | undefined, now: Date = new Date()): Record<string, any> {
  const f = accountTypeFields(form.type);
  const sfId = form.simplefinAccountId.trim() || null;
  const balance = num(form.currentBalance) ?? 0;
  const balanceChanged = !existing || Math.abs((existing.currentBalance ?? 0) - balance) >= 0.005;
  return {
    name: form.name.trim(),
    type: form.type,
    retirementType: f.retirementType ? form.retirementType : null,
    institution: form.institution.trim() || null,
    last4: form.last4.trim() || null,
    currentBalance: balance,
    ownerPersonIds: form.ownerPersonIds,
    active: form.active,
    sortOrder: num(form.sortOrder),
    minBalance: f.minBalance ? num(form.minBalance) : null,
    creditLimit: f.creditLimit ? num(form.creditLimit) : null,
    statementDueDay: f.statementDueDay ? num(form.statementDueDay) : null,
    apr: f.apr ? pctOut(form.apr) : null,
    apy: f.apy ? pctOut(form.apy) : null,
    simplefinAccountId: sfId,
    simplefinConnection: sfId ? form.simplefinConnection : null,
    notes: form.notes.trim() || null,
    ...(balanceChanged ? { balanceUpdatedAt: now.toISOString() } : {}),
  };
}

/** Validate, then create or update the account. Returns the error to show, or null when saved. */
export async function saveAccountForm(client: Client, form: AccountForm, accounts: Array<{ id: string; name: string; currentBalance?: number | null; simplefinAccountId?: string | null }>): Promise<string | null> {
  const invalid = validateAccountForm(form, accounts);
  if (invalid) return invalid;
  const existing = form.id ? accounts.find((a) => a.id === form.id) : null;
  const row = accountWriteRow(form, existing);
  const r = form.id ? await client.models.homeFinanceAccount.update({ id: form.id, ...row }) : await client.models.homeFinanceAccount.create(row);
  if (r.errors?.length) throw new Error(r.errors[0].message);
  return null;
}

// ── SimpleFIN picker ────────────────────────────────────────────────────

export type SfAccount = { id: string; institution: string; name: string; connection: string; mappedTo: { id: string; name: string } | null };
export type SfConnection = { key: string; label: string; ok: boolean; error: string | null };
export type SfListing = { accounts: SfAccount[]; connections: SfConnection[]; error: string | null };

/** The listSimplefinAccounts result (AWSJSON: parsed, or one or more layers of string). */
export function parseSimplefinListing(raw: unknown): SfListing {
  let d: any = raw;
  while (typeof d === "string") d = JSON.parse(d);
  d = d ?? {};
  return { accounts: d.accounts ?? [], connections: d.connections ?? [], error: d.error ?? null };
}

export type SfPickerRow = SfAccount & { selected: boolean; taken: boolean };
export type SfPickerGroup = SfConnection & { rows: SfPickerRow[] };

/**
 * One group per connection (every configured one when the listing names
 * none), each with its accounts: `selected` when it's the form's current
 * link, `taken` when another account already uses it.
 */
export function simplefinPickerGroups(listing: Pick<SfListing, "accounts" | "connections">, form: Pick<AccountForm, "id" | "simplefinAccountId" | "simplefinConnection"> | null): SfPickerGroup[] {
  const conns: SfConnection[] = listing.connections.length ? listing.connections : SIMPLEFIN_CONNECTIONS.map((c) => ({ key: c.key, label: c.label, ok: true, error: null }));
  return conns.map((conn) => ({
    ...conn,
    rows: listing.accounts
      .filter((s) => s.connection === conn.key)
      .map((s) => {
        const mine = !!form?.id && s.mappedTo?.id === form.id;
        return { ...s, selected: form?.simplefinAccountId === s.id && form?.simplefinConnection === s.connection, taken: !!s.mappedTo && !mine };
      }),
  }));
}

/** The form after picking a SimpleFIN account: its id and connection, and its institution when none is set. */
export function pickSimplefinAccount(form: AccountForm, s: Pick<SfAccount, "id" | "connection" | "institution">): AccountForm {
  return { ...form, simplefinAccountId: s.id, simplefinConnection: s.connection, institution: form.institution || s.institution };
}

// ── Delete ──────────────────────────────────────────────────────────────

/** Whether the account has any transaction (deleting it would orphan them). Throws when the check fails. */
export async function accountHasTransactions(client: Client, accountId: string): Promise<boolean> {
  const { data, errors } = await txIndexQuery(client, "AccountIdAndDate")({ accountId }, { limit: 1 });
  if (errors?.length) throw new Error(errors[0].message);
  return !!data?.length;
}

/** Delete the account row, then its holdings. Throws when the account delete fails. */
export async function deleteAccountWithHoldings(client: Client, accountId: string): Promise<void> {
  const r = await client.models.homeFinanceAccount.delete({ id: accountId });
  if (r.errors?.length) throw new Error(r.errors[0].message);
  for (const h of await listHoldings(client, accountId)) {
    await client.models.homeFinanceHolding.delete({ accountId: h.accountId, holdingKey: h.holdingKey });
  }
}

export const ACCOUNT_HAS_TRANSACTIONS = { title: "This account has transactions", detail: "Turn off Active instead, so its history stays in the reports." };
