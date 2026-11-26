// Invoices / receipts / bills (homeInvoice, from invoices@ or a PDF upload)
// and the transactions that paid them (homeInvoiceLink, many-to-many). The
// web and phone Invoices screens read the models directly; these ops give
// Janet, the external API and `hh` the same view and edits, using the
// shared rules in lib/finance/invoice-screen.ts.
//
// Owners and privacy (lib/finance/invoice-owner.ts): another member's
// private invoice doesn't exist for the caller, and none is private-visible
// in a group chat. The caller is the verified login (web / phone), else the
// person the surface speaks for (Janet's sender, the API key's member).
//
// The PDF facsimile is the record. It's only handed out as a signed /api/d
// link (lib/file-link.ts), and only by surfaces that can sign one
// (ctx.fileLink: the agent Lambda, which serves Janet and the API).

import { z } from "zod/v4";
import { listAllPages } from "../list-all";
import { householdMembers } from "../household";
import { invoiceOwnerError, invoiceOwnerIds, invoiceVisibleTo } from "../finance/invoice-owner";
import { listTransactions } from "../finance/data";
import { normalizeCategoryName } from "../finance/categories";
import { rememberCategories } from "../finance/category-list";
import {
  filterInvoices,
  invoiceDate,
  invoiceIsPaid,
  invoiceTotals,
  parseInvoiceItems,
  paymentCandidates,
  paymentSearchRange,
} from "../finance/invoice-screen";
import type { OpContext } from "./context";
import { OpError, defineOp } from "./define";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const ItemOut = z.object({ description: z.string(), qty: z.number().nullable(), unitPrice: z.number().nullable(), amount: z.number().nullable() });

const PaymentOut = z.object({
  linkId: z.string(),
  transactionId: z.string(),
  amount: z.number().nullable().describe("This payment's share of the invoice; null = all of it"),
  date: z.string().nullable(),
  description: z.string().nullable(),
  transactionAmount: z.number().nullable(),
});

const InvoiceOut = z.object({
  id: z.string(),
  vendor: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  date: z.string().describe("Issue date, else when it arrived"),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  currency: z.string(),
  subtotal: z.number().nullable(),
  tax: z.number().nullable(),
  total: z.number().nullable(),
  category: z.string().nullable(),
  spendGroupId: z.string().nullable(),
  ownerPersonIds: z.array(z.string()).describe("[] = the household's"),
  owners: z.array(z.string()).describe("Owners' names; [] = household"),
  private: z.boolean().describe("Shown only to its owners"),
  paid: z.boolean().describe("Marked paid, or linked to a payment"),
  markedPaid: z.boolean(),
  parseStatus: z.string().describe("PARSED, NEEDS_REVIEW (total unread: check it) or ERROR"),
  parseError: z.string().nullable(),
  source: z.string().nullable().describe("EMAIL or UPLOAD"),
  emailFrom: z.string().nullable(),
  emailSubject: z.string().nullable(),
  notes: z.string().nullable(),
  items: z.array(ItemOut),
  payments: z.array(PaymentOut),
  pdfLink: z.string().nullable().describe("Signed link to the PDF, valid 15 minutes; null where it can't be signed"),
});

type InvoiceView = z.infer<typeof InvoiceOut>;

type Member = { id: string; name: string; cognitoUsername?: string | null; active?: boolean | null; groups?: (string | null)[] | null };

const household = async (ctx: OpContext) => householdMembers(await listAllPages<Member>(ctx.client.models.homePerson));

/** Who's asking: the verified login, else the named person; nobody in a group chat (private stays hidden there). */
function viewerOf(ctx: OpContext, folks: Member[]): Member | null {
  if (ctx.actor.groupChat) return null;
  if (ctx.actor.username) return folks.find((p) => p.cognitoUsername === ctx.actor.username) ?? null;
  const name = (ctx.actor.personName ?? "").trim().toLowerCase();
  return name ? (folks.find((p) => p.name.toLowerCase() === name) ?? null) : null;
}

function memberRef(folks: Member[], ref: string): Member {
  const q = ref.trim().toLowerCase();
  const p = folks.find((x) => x.id === ref) ?? folks.find((x) => x.name.toLowerCase() === q);
  if (!p) throw new OpError(`No household member "${ref}". Household: ${folks.map((x) => x.name).join(", ")}`);
  return p;
}

/** ownerPersonIds / ownerNames → ids ("household" alone = [], "both" = the adults); undefined = not given. */
function ownerIdsFrom(folks: Member[], ids: string[] | undefined, names: string[] | undefined): string[] | undefined {
  if (ids === undefined && names === undefined) return undefined;
  const out = (ids ?? []).map((id) => memberRef(folks, id).id);
  for (const n of names ?? []) {
    const want = n.trim().toLowerCase();
    if (want === "household" || want === "everyone") continue;
    if (want === "both") {
      const adults = folks.filter((p) => p.cognitoUsername);
      out.push(...(adults.length ? adults : folks).map((p) => p.id));
      continue;
    }
    out.push(memberRef(folks, n).id);
  }
  return [...new Set(out)];
}

async function loadInvoices(ctx: OpContext) {
  const [all, links, folks] = await Promise.all([listAllPages<any>(ctx.client.models.homeInvoice), listAllPages<any>(ctx.client.models.homeInvoiceLink), household(ctx)]);
  const viewer = viewerOf(ctx, folks);
  const invoices = all.filter((inv) => invoiceVisibleTo(inv, viewer?.id));
  return { invoices, links, linkedIds: new Set<string>(links.map((l) => l.invoiceId)), folks, viewer };
}

async function pdfLink(ctx: OpContext, key: string | null | undefined): Promise<string | null> {
  if (!key || !ctx.fileLink) return null;
  try {
    return await ctx.fileLink(key);
  } catch {
    return null;
  }
}

async function invoiceView(ctx: OpContext, inv: any, links: any[], linkedIds: Set<string>, withPayments: boolean, folks: Member[]): Promise<InvoiceView> {
  const ownerPersonIds = invoiceOwnerIds(inv);
  const mine = links.filter((l) => l.invoiceId === inv.id);
  const payments = withPayments
    ? await Promise.all(
        mine.map(async (l) => {
          const { data: tx } = await ctx.client.models.homeFinanceTransaction.get({ id: l.transactionId });
          return { linkId: l.id, transactionId: l.transactionId, amount: l.amount ?? null, date: tx?.date ?? null, description: tx?.description ?? null, transactionAmount: tx?.amount ?? null };
        }),
      )
    : mine.map((l) => ({ linkId: l.id, transactionId: l.transactionId, amount: l.amount ?? null, date: null, description: null, transactionAmount: null }));
  return {
    id: inv.id,
    vendor: inv.vendor ?? null,
    invoiceNumber: inv.invoiceNumber ?? null,
    date: invoiceDate(inv),
    issueDate: inv.issueDate ?? null,
    dueDate: inv.dueDate ?? null,
    currency: inv.currency ?? "USD",
    subtotal: inv.subtotal ?? null,
    tax: inv.tax ?? null,
    total: inv.total ?? null,
    category: inv.category ?? null,
    spendGroupId: inv.spendGroupId ?? null,
    ownerPersonIds,
    owners: ownerPersonIds.map((id) => folks.find((p) => p.id === id)?.name ?? id),
    private: !!inv.private,
    paid: invoiceIsPaid(inv, linkedIds),
    markedPaid: !!inv.paid,
    parseStatus: inv.parseStatus ?? "PARSED",
    parseError: inv.parseError ?? null,
    source: inv.source ?? null,
    emailFrom: inv.emailFrom ?? null,
    emailSubject: inv.emailSubject ?? null,
    notes: inv.notes ?? null,
    items: parseInvoiceItems(inv.items),
    payments,
    pdfLink: await pdfLink(ctx, inv.s3KeyPdf),
  };
}

/** The invoice, if the caller may see it (another member's private one reads as missing). */
async function getInvoice(ctx: OpContext, id: string): Promise<any> {
  const { data } = await ctx.client.models.homeInvoice.get({ id });
  if (!data || !invoiceVisibleTo(data, viewerOf(ctx, await household(ctx))?.id)) throw new OpError(`No invoice ${id}. Use list_invoices to find the id.`);
  return data;
}

// ── list_invoices ──────────────────────────────────────────────────────────

export const listInvoices = defineOp({
  name: "list_invoices",
  domain: "finance",
  access: "read",
  description:
    "The household's invoices, receipts and bills (emailed to the invoices inbox or uploaded as PDFs): vendor, number, dates, total, line items, category, whether it's paid and by which transactions, and a link to the PDF. Ones that need review (total unread) come first, then newest. Answers 'what do we owe the contractor?', 'unpaid invoices', 'how much did the plumber charge in March?', 'show me the Crate & Barrel receipt'. query matches vendor, number, category and notes. personName narrows to that member's invoices plus the household's ('my invoices': pass the speaker). Private invoices are only listed for their owner, never in a group chat.",
  input: z.object({
    invoiceId: z.string().optional().describe("Return just this invoice, with its payments' dates and descriptions."),
    query: z.string().optional().describe("Words that must all appear in vendor, invoice number, category or notes."),
    paid: z.enum(["all", "unpaid", "paid"]).optional().describe("Default all. Paid = marked paid or linked to a payment."),
    status: z.enum(["all", "review", "parsed"]).optional().describe("review = NEEDS_REVIEW or ERROR. Default all."),
    year: z.string().regex(/^\d{4}$/).optional().describe("Issue year (else the year it arrived)."),
    fromDate: DATE.optional(),
    toDate: DATE.optional(),
    personId: z.string().optional().describe("Only this member's invoices and the household's."),
    personName: z.string().optional().describe("Same as personId, by name."),
    limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
  }),
  output: z.object({
    count: z.number().describe("Matches before the limit"),
    total: z.number().describe("Sum of the matches' totals"),
    unpaid: z.number().describe("Sum of the matches' unpaid totals"),
    needsReview: z.number(),
    invoices: z.array(InvoiceOut),
  }),
  async run(ctx, input) {
    const { invoices, links, linkedIds, folks, viewer } = await loadInvoices(ctx);
    const owner = input.personId || input.personName ? memberRef(folks, (input.personId ?? input.personName)!).id : "all";
    let shown = filterInvoices(invoices, linkedIds, { status: input.status ?? "all", paid: input.paid ?? "all", year: input.year ?? "all", query: input.query ?? "", viewer: viewer?.id ?? null, owner });
    if (input.invoiceId) shown = shown.filter((i) => i.id === input.invoiceId);
    if (input.fromDate) shown = shown.filter((i) => invoiceDate(i) >= input.fromDate!);
    if (input.toDate) shown = shown.filter((i) => invoiceDate(i) <= input.toDate!);
    const totals = invoiceTotals(shown, linkedIds);
    const page = shown.slice(0, input.limit ?? 50);
    return {
      count: shown.length,
      total: totals.sum,
      unpaid: totals.unpaid,
      needsReview: totals.review,
      invoices: await Promise.all(page.map((inv) => invoiceView(ctx, inv, links, linkedIds, !!input.invoiceId, folks))),
    };
  },
});

// ── save_invoice ───────────────────────────────────────────────────────────

const ItemIn = z.object({
  description: z.string(),
  qty: z.number().nullable().optional(),
  unitPrice: z.number().nullable().optional(),
  amount: z.number().nullable().optional(),
});

export const saveInvoice = defineOp({
  name: "save_invoice",
  domain: "finance",
  access: "write",
  description:
    "Correct or file an invoice (they arrive by email or PDF upload, so this edits, it doesn't create). Only the fields given change; null clears one. Use it to fix what the reader got wrong (vendor, total, dates), set its category or spend group, say whose it is (ownerNames: a member, 'both', or 'household') and whether it's private (only its owners see it; needs an owner), add notes, or mark it paid without a matching transaction (link_invoice_payment links the one that paid it). Setting the total on a NEEDS_REVIEW invoice marks it PARSED. items replaces the line items.",
  input: z.object({
    invoiceId: z.string(),
    vendor: z.string().nullable().optional(),
    invoiceNumber: z.string().nullable().optional(),
    issueDate: DATE.nullable().optional(),
    dueDate: DATE.nullable().optional(),
    currency: z.string().length(3).optional(),
    subtotal: z.number().nullable().optional(),
    tax: z.number().nullable().optional(),
    total: z.number().nullable().optional(),
    category: z.string().nullable().optional().describe('A finance category, "Parent: Child" for a sub-category'),
    spendGroupId: z.string().nullable().optional().describe("From list_finance_spend_groups"),
    paid: z.boolean().optional(),
    notes: z.string().nullable().optional(),
    items: z.array(ItemIn).optional(),
    ownerPersonIds: z.array(z.string()).optional().describe("Whose, by id; [] = household. Replaces the owners."),
    ownerNames: z.array(z.string()).optional().describe("Whose, by name ('both' = the adults, 'household'). Replaces the owners."),
    private: z.boolean().optional().describe("Only its owners see it. Needs an owner."),
  }),
  output: z.object({ invoice: InvoiceOut, newCategories: z.array(z.string()) }),
  async run(ctx, input) {
    const inv = await getInvoice(ctx, input.invoiceId);
    const text = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
    const patch: Record<string, unknown> = {};
    for (const k of ["vendor", "invoiceNumber", "notes"] as const) if (input[k] !== undefined) patch[k] = text(input[k]);
    for (const k of ["issueDate", "dueDate", "subtotal", "tax", "total", "paid"] as const) if (input[k] !== undefined) patch[k] = input[k];
    if (input.currency !== undefined) patch.currency = input.currency.toUpperCase();
    if (input.category !== undefined) patch.category = normalizeCategoryName(input.category ?? "") || null;
    if (input.spendGroupId !== undefined) {
      if (input.spendGroupId) {
        const { data: g } = await ctx.client.models.homeFinanceSpendGroup.get({ id: input.spendGroupId });
        if (!g) throw new OpError(`No spend group ${input.spendGroupId}. Use list_finance_spend_groups.`);
      }
      patch.spendGroupId = input.spendGroupId || null;
    }
    if (input.items !== undefined) {
      const items = input.items
        .map((it) => ({ description: it.description.trim(), qty: it.qty ?? null, unitPrice: it.unitPrice ?? null, amount: it.amount ?? null }))
        .filter((it) => it.description || it.amount != null);
      patch.items = items.length ? JSON.stringify(items) : null;
    }
    const folks = await household(ctx);
    const owners = ownerIdsFrom(folks, input.ownerPersonIds, input.ownerNames);
    if (owners !== undefined) patch.ownerPersonIds = owners;
    if (input.private !== undefined) patch.private = input.private;
    const ownerErr = invoiceOwnerError(owners ?? invoiceOwnerIds(inv), input.private ?? !!inv.private);
    if (ownerErr) throw new OpError(ownerErr);
    // Making it private for others would hide it from the caller too.
    const viewer = viewerOf(ctx, folks);
    if ((input.private ?? inv.private) && !(owners ?? invoiceOwnerIds(inv)).includes(viewer?.id ?? "")) {
      throw new OpError("You can only keep an invoice private if you're one of its owners.");
    }
    if (!Object.keys(patch).length) throw new OpError("Nothing to change");
    // A person-checked total is what review was waiting for.
    if (typeof input.total === "number" && inv.parseStatus !== "PARSED") Object.assign(patch, { parseStatus: "PARSED", parseError: null });
    const r = await ctx.client.models.homeInvoice.update({ id: inv.id, ...patch });
    if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
    const newCategories = patch.category ? await rememberCategories(ctx.client, [patch.category as string]) : [];
    const { links, linkedIds } = await loadInvoices(ctx);
    return { invoice: await invoiceView(ctx, r.data, links, linkedIds, true, folks), newCategories };
  },
});

// ── find_invoice_payments ──────────────────────────────────────────────────

const CandidateOut = z.object({ transactionId: z.string(), date: z.string().nullable(), description: z.string().nullable(), amount: z.number().nullable(), accountId: z.string() });

export const findInvoicePayments = defineOp({
  name: "find_invoice_payments",
  domain: "finance",
  access: "read",
  description:
    "Transactions that could have paid an invoice, for link_invoice_payment: `exact` are within a cent of the total from 2 days before to 10 days after its issue (or due) date; `close` are within 5% of the total, 30 days either side, closest first. Ones already linked to it are left out.",
  input: z.object({
    invoiceId: z.string(),
    amount: z.number().optional().describe("Look for this amount instead of the invoice total (a partial payment)."),
  }),
  output: z.object({ exact: z.array(CandidateOut), close: z.array(CandidateOut) }),
  async run(ctx, input) {
    const inv = await getInvoice(ctx, input.invoiceId);
    const anchor = inv.issueDate || inv.dueDate || invoiceDate(inv);
    const total = input.amount ?? inv.total;
    if (!anchor) throw new OpError("The invoice has no date to search around; set issueDate with save_invoice");
    if (total == null) throw new OpError("The invoice has no total; set it with save_invoice, or pass amount");
    const links = await listAllPages<any>(ctx.client.models.homeInvoiceLink);
    const linked = new Set<string>(links.filter((l) => l.invoiceId === inv.id).map((l) => l.transactionId));
    const txs = await listTransactions(ctx.client, paymentSearchRange(anchor));
    const { exact, loose } = paymentCandidates(txs, anchor, total, linked);
    const out = (t: any) => ({ transactionId: t.id, date: t.date ?? null, description: t.description ?? null, amount: t.amount ?? null, accountId: t.accountId });
    return { exact: exact.map(out), close: loose.slice(0, 20).map(out) };
  },
});

// ── link_invoice_payment ───────────────────────────────────────────────────

export const linkInvoicePayment = defineOp({
  name: "link_invoice_payment",
  domain: "finance",
  access: "write",
  description:
    "Record which transaction paid an invoice (find it with find_invoice_payments or list_finance_transactions), which marks the invoice paid. A payment can cover several invoices and an invoice can be paid in parts: amount is this transaction's share (leave out for all of it). unlink: true removes the link instead (the invoice stays marked paid; save_invoice paid: false clears that).",
  input: z.object({
    invoiceId: z.string(),
    transactionId: z.string(),
    amount: z.number().positive().optional().describe("This payment's share of the invoice; default the whole total."),
    unlink: z.boolean().optional(),
  }),
  output: z.object({ action: z.enum(["linked", "already linked", "unlinked"]), invoice: InvoiceOut }),
  async run(ctx, input) {
    const inv = await getInvoice(ctx, input.invoiceId);
    const links = await listAllPages<any>(ctx.client.models.homeInvoiceLink);
    const existing = links.find((l) => l.invoiceId === inv.id && l.transactionId === input.transactionId);
    let action: "linked" | "already linked" | "unlinked";
    if (input.unlink) {
      if (!existing) throw new OpError("That transaction isn't linked to this invoice");
      const r = await ctx.client.models.homeInvoiceLink.delete({ id: existing.id });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      action = "unlinked";
    } else if (existing) {
      action = "already linked";
    } else {
      const { data: tx } = await ctx.client.models.homeFinanceTransaction.get({ id: input.transactionId });
      if (!tx) throw new OpError(`No transaction ${input.transactionId}. Use find_invoice_payments or list_finance_transactions.`);
      const r = await ctx.client.models.homeInvoiceLink.create({ invoiceId: inv.id, transactionId: tx.id, amount: input.amount ?? inv.total ?? null });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      // Same as the web's Link: linking marks it paid.
      if (!inv.paid) await ctx.client.models.homeInvoice.update({ id: inv.id, paid: true });
      action = "linked";
    }
    const fresh = await loadInvoices(ctx);
    const row = fresh.invoices.find((i) => i.id === inv.id) ?? inv;
    return { action, invoice: await invoiceView(ctx, row, fresh.links, fresh.linkedIds, true, fresh.folks) };
  },
});

export const invoiceOps = [listInvoices, saveInvoice, findInvoicePayments, linkInvoicePayment];
