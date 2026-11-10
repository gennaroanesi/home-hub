# Household finance

Status: built 2026-11-09, not yet deployed. The joint account doesn't exist
yet; everything works with no accounts and fills in once it's opened and
linked.

## What it is

A finance section for the household's joint account(s): balances, every
transaction (synced from SimpleFIN), a budget per month with what each of us
puts in, scheduled payments (mortgage, car, utilities, contributions), savings
goals and spend groups. Ported and trimmed from gennaroanesi.com's
`/finance` (no holdings, RSU, paychecks, tax, loans or simulator), so the
personal finances stay there and household ones live here.

Household differences from gennaroanesi.com:

- **Income is contributions.** Money moving into the joint account from one
  of our own accounts is categorized `Contribution` (a money-in row that a
  transfer rule matched). Rows carry a `personId`, set by rules ("transfer
  from … 1234" → Gennaro) or by hand, so the budget shows planned vs received
  per person.
- **Mortgage and car are ordinary budgeted spending.** Only transfers between
  tracked accounts and card payments are left out.
- **Savings is a budget line, not spending.** A SAVINGS line names an
  account (`accountId`) and an amount per period; actual = what landed in
  that account in the period, minus withdrawals, not counting interest
  (`savedByAccount` in `lib/finance/budget.ts`). The money moves as a
  transfer, so it never shows as spending. Contributions are planned to
  cover spending + savings (`unallocated` = contributions − spending −
  savings).
- **Budget pools collapse to one.** INCOME budget lines are per contributor
  (`personId`) instead of salary / bonus / RSU.
- **homeBill is gone.** Bills are scheduled transactions
  (`homeFinanceRecurring`, with `autopay` and `url`). Prod had no bill rows
  when it was removed (checked 2026-11-09), so there was nothing to migrate.

## Pieces

| Where | What |
|---|---|
| `amplify/data/resource.ts` | `homeFinanceAccount`, `…Transaction` (index accountId+date, recurringId, spendGroupId), `…Recurring`, `…Budget` (versioned, SCD2), `…SavingsGoal`, `…SpendGroup`, `…CategoryRule`, `…SyncLog`, `…AccountSnapshot` (identifier accountId+date); `syncFinance` and `listSimplefinAccounts` mutations |
| `lib/finance/` | Pure logic shared by pages, ops and the Lambda: `categories.ts` + `category-rules.json`, `budget.ts`, `recurring.ts` (matching, projection), `goals.ts`, `dates.ts`, `sync-engine.ts`, `simplefin.ts`, `data.ts` (loading through the indexes) |
| `amplify/functions/finance-sync/` | SimpleFIN sync: 3×/day (04:30, 12:30, 19:30 America/Chicago), plus the two mutations. Rules first, Haiku fallback for the rest, pending → posted in place (amount included), auto-links posted rows to schedules and rolls `nextDate`, upserts today's balance snapshot per account, writes a sync log |
| `lib/ops/finance.ts` | `get_finance_summary`, `list_finance_transactions`, `update_finance_transaction` (with `rememberPattern` → rule), `save_finance_budget`, `list_finance_schedules`, `save_finance_schedule`, `save_finance_goal`, `list_finance_categories` — Janet, the API, `hh` and the pages' writes |
| `pages/finance/` | Overview, Transactions, Budget, Review, Scheduled, Goals, Groups, Accounts (+ detail), Rules. Frame and shared bits in `components/finance/` |

## Paychecks, tax outlook, invoices (2026-11-09)

Home-hub now owns paychecks (moved from gennaroanesi.com, which keeps its
copy until its pages are pointed here or retired).

| Where | What |
|---|---|
| `homePaycheck` | One row per stub per person (`personId`, not ME/SPOUSE), headline + YTD columns, `lineItems` JSON, `s3KeyPdf`, `source`, `importRef` |
| `homePaycheckInbox` | Emailed stubs waiting for review; Claude output never lands in `homePaycheck` unreviewed |
| `homeInvoice` / `homeInvoiceLink` | Household invoices and the transactions that paid them |
| `homeFinanceSetting` | JSON settings by key (`tax-outlook:<year>`) |
| `amplify/functions/paycheck-processor` | Email (S3 trigger) → inbox rows; `parsePaycheckPdf` mutation for uploads |
| `amplify/functions/invoice-processor` | Email (S3 trigger) or `ingestInvoicePdf` upload → `homeInvoice`, auto-links the one matching transaction; renders bodies without a PDF with Chromium (public layer) |
| `lib/finance/` | `inbound-mail.ts` (gate + MIME), `paycheck-extract.ts` / `invoice-extract.ts` (Claude, server-only), `paycheck-fields.ts` / `invoice-fields.ts` (browser-safe), `paychecks.ts` (contributions vs pay), `tax.ts` (projection, 401k caps, safe harbor), `finance-files.ts` (S3 layout) |
| `pages/api/finance/` | `upload-url` (PDF presign to `home/finance/staging/…`), `file` (authenticated 5-minute links; `/api/d` is unauthenticated, so not used for these) |
| Pages | `/finance/paychecks` (stubs, review inbox, upload, contributions vs pay), `/finance/tax-outlook`, `/finance/invoices` |

**Email.** `paychecks@import.cristinegennaro.com` and
`invoices@import.cristinegennaro.com` (`home.` is Amplify's CNAME, which
can't also have MX). SES stores mail in `FinanceInboundMailBucket` (CDK,
90-day expiry) under `paychecks/` or `invoices/`; the bucket notification
invokes the processor. Before any parsing or Claude call, a message must
pass SES's spam/virus verdicts, come from an address in
`FINANCE_INBOUND_ALLOWED_SENDERS` (comma-separated, env var, read at deploy),
and SES must vouch for the From domain: DMARC pass, or a DKIM / SPF pass for
that same domain (an address typed into From proves nothing; a pass for some
other domain doesn't count). Only SES's own headers are read — the topmost
`Authentication-Results` (authserv-id `amazonses.com`) and `X-SES-*-Verdict` —
since a sender can add copies of their own further down. Two From lines are
refused. Empty list = everything dropped (logged as `dropped …`). After the
first real email, check its headers look as expected (`dropped …` in the
processor log names the reason).

**Setup (once, per environment that should receive mail):**
1. Set `FINANCE_INBOUND_ALLOWED_SENDERS` (both of our addresses) in
   `.env.local` for the sandbox and in Amplify Hosting env vars for main.
2. Deploy, then `AWS_PROFILE=admin scripts/setup-finance-inbound-email.sh`
   (dry run) and again with `--apply`: SES identity + DKIM, Route53 MX, and
   two receipt rules in the account's active rule set (shared with
   91dispatcher and gennaroanesi.com; the script only touches its own rules).
3. Move the history: `npx tsx scripts/import-gennaroanesi-paychecks.ts --from
   <gennaroanesi.com prod outputs> --to <home-hub prod outputs>` (dry run),
   then `--yes`. Needs `GA_USER`/`GA_PASS` (gennaroanesi.com admin login).

Verified on the sandbox: upload → `parsePaycheckPdf` (Claude extraction,
person match, duplicate detection), `ingestInvoicePdf` (extraction +
semantic dedup), and an email dropped by the gate. Not yet exercised: real
SES delivery and the Chromium body render (needs an allowed sender).

## SimpleFIN

**Duplicates.** A synced row's id is `sf-<accountId>-<SimpleFIN id>`
(`syncedTransactionId`), so DynamoDB refuses a second copy no matter what
the dedup read saw; the sync counts that as a duplicate. If reading the
stored rows fails, the sync writes nothing and logs ERROR. Not handled yet:
a bank that gives the posted charge a different SimpleFIN id than the
pending one (the pending row would stay) — check after the first weeks of
real data.

The access URL is the one gennaroanesi.com uses (Secrets Manager
`gennaroanesi/simplefin`, same AWS account). That token can see the personal
accounts too, so:

- the sync only asks SimpleFIN for the ids mapped on `homeFinanceAccount`
  (`fetchAccounts` throws if called without ids unless `allAccounts` is set,
  and the handler drops anything it didn't ask for);
- the account picker (`listSimplefinAccounts`) uses `balances-only=1` and
  returns only id, institution and name. Anyone in `home-users` can see that
  list, i.e. the names of the personal accounts on the token. Moving to a
  separate SimpleFIN connection later is a secret swap in `backend.ts`.
- SimpleFIN rate-limits per token. gennaroanesi.com pulls at roughly 4/12/19h
  Chicago; these runs are 30 minutes later.

## Setting it up (once the joint account exists)

1. Deploy. Check the first scheduled run wrote a `homeFinanceSyncLog` row
   (status OK, 0 accounts) — or press *Sync now* on any finance page.
2. Add the bank connection for the joint account in SimpleFIN Bridge (same
   SimpleFIN login as gennaroanesi.com).
3. *Finance → Accounts → Add*, type Checking, no owners (= joint), set a
   buffer (`minBalance`), then *Pick* the SimpleFIN account. *Sync now*.
4. *Rules*: copy the built-in rules to editable ones, then add one rule per
   person for their incoming transfer ("transfer from … 1234" → person,
   category Contribution) so contributions are attributed automatically.
5. *Scheduled*: mortgage, car, utilities, insurance, each person's
   contribution, with a match pattern from the bank description.
6. *Budget*: one INCOME line per person, then spending lines (*Start from
   history* once there are a couple of months of data).

## Next

- Point gennaroanesi.com's paycheck consumers (overview, agent, planning
  simulator) at home-hub or retire them; stop paychecks@gennaroanesi.com.
- Ops for Janet: paycheck / tax outlook summaries ("how much have we
  withheld this year?", "are we on track to owe?").

- **Alerts** (the reason for the projection code): a daily check that posts
  to the household WhatsApp via `homeOutboundMessage` when the projected
  balance dips under the buffer before a scheduled debit, a contribution is
  late, a budget line passes 90% early in the month, or an unusually large /
  new-merchant charge posts. `get_finance_summary` already computes the low
  point; the check would reuse `lib/finance/recurring.ts` and `budget.ts`.
- A finance line in the daily summary (upcoming debits today/tomorrow).
- Mobile screen (`more/finance`), reading the same ops.
- Budget rollover (`rollover` is stored but not applied; gennaroanesi.com
  freezes period rows for it in `financeBudgetPeriod`).
- Loans (mortgage / car amortization) if the payoff view is wanted here.
- `goalId` has no index; the Goals page loads all transactions to total
  tagged ones. Fine for one account, add an index if it gets slow.
