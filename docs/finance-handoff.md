# Household finance

Status: built 2026-11-09, not yet deployed. The joint account doesn't exist
yet; everything works with no accounts and fills in once it's opened and
linked.

## What it is

A finance section for the household's joint account(s): balances, every
transaction (synced from SimpleFIN), a budget per month with what each of us
puts in, scheduled payments (mortgage, car, utilities, contributions), savings
goals and spend groups. Ported and trimmed from gennaroanesi.com's
`/finance` (no tax lots, live quotes, RSU, loans or simulator), so the
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
- **Invested accounts are for goals, not cash flow.** BROKERAGE and
  RETIREMENT accounts (401k, IRA, HSA; `retirementType`) sync their balance,
  positions (`homeFinanceHolding`, identifier accountId+holdingKey) and
  transactions. The transactions are rule-classified only (no Haiku, no
  schedule matching) and stay out of everything budget-like: the budget,
  overview, review, contributions vs pay, Janet's summary, invoice matching.
  `listTransactions` without `accountIds` leaves them out, and
  `householdAccounts()` (lib/finance/accounts.ts) is the account list for
  budget views; the account page and the Transactions page (filtered to
  that account) show them. Their `currentBalance` is the total value, positions
  included (gennaroanesi.com stores cash only and values positions from live
  quotes; here a position's `marketValue` is what SimpleFIN reported at the
  last sync). `holdingKey` is the ticker, or `FUND:<description>` for 401k
  trust funds without one. The sync owns SIMPLEFIN rows (creates, updates,
  deletes sold-out positions); MANUAL rows are left alone. A savings budget
  line can't point at an invested account (nothing would count); a goal can.
- **Goals can draw on several accounts.** `fundingAccountIds` (ordered;
  the older single `fundingAccountId` still reads): a retirement goal over
  both 401ks. Goals fill in priority order, each taking from its accounts in
  order, so two goals never count the same dollars.
- **Itemized charges.** `homeFinanceTransaction.lineItems` (JSON string of
  `{ name, amount, category, quantity? }`), ported from gennaroanesi.com,
  splits one charge across categories (an Amazon order). Every category
  total goes through `categoryParts` (lib/finance/categories.ts): per item
  category, scaled so the parts sum to the charge, so tax and shipping
  spread proportionally; a plain row is one part. The budget, review,
  seeding and the Transactions filter use it; `effectiveCategory` of an
  itemized row is its largest item's category. Edited in the transaction
  window ("Itemize") or by Janet (`update_finance_transaction` `lineItems`).
  gennaroanesi.com also fills it from Amazon's order export
  (`scripts/amazon_itemize.mjs`); not ported yet.
- **Goal milestones** (`homeFinanceGoalMilestone`: goalId, targetAmount,
  targetDate, label), ported from gennaroanesi.com. Status is derived
  against the goal's current progress (`milestoneViews` in `goals.ts`): HIT,
  MISSED (date passed first) or PENDING, live, so a 401k-funded goal can
  drop back below one. The next pending milestone also gets the monthly
  pace to reach it. Written only through `save_finance_goal` (`milestones`
  replaces the list; ids keep rows in place); shown as markers on the goal's
  bar and in Janet's summary.
- **homeBill is gone.** Bills are scheduled transactions
  (`homeFinanceRecurring`, with `autopay` and `url`). Prod had no bill rows
  when it was removed (checked 2026-11-09), so there was nothing to migrate.

## Pieces

| Where | What |
|---|---|
| `amplify/data/resource.ts` | `homeFinanceAccount`, `…Transaction` (index accountId+date, recurringId, spendGroupId), `…Recurring`, `…Budget` (versioned, SCD2), `…SavingsGoal`, `…GoalMilestone`, `…SpendGroup`, `…CategoryRule`, `…SyncLog`, `…AccountSnapshot` (identifier accountId+date), `…Holding` (identifier accountId+holdingKey), `…Asset`, `…AssetValuation`, `…Loan`, `…LoanPayment`; `syncFinance` and `listSimplefinAccounts` mutations. `syncFinance` (except a dry run) only starts the run, as an async invoke of finance-sync (`{ manualSync }`), and returns `{ status: "STARTED", requestedAt }`: a run outlasts AppSync's 30s. Web and phone then poll for the MANUAL sync log row started after `requestedAt` (`waitForSync` in `lib/finance/sync-result.ts`) |
| `lib/finance/` | Pure logic shared by pages, ops and the Lambda: `categories.ts` + `category-rules.json`, `budget.ts`, `recurring.ts` (matching, projection), `goals.ts`, `accounts.ts` (types, `isInvested`), `dates.ts`, `loans.ts`, `net-worth.ts`, `sync-engine.ts` (incl. the holdings diff), `simplefin.ts`, `simplefin-connections.ts` (one connection per person), `data.ts` (loading through the indexes) |
| `amplify/functions/finance-sync/` | SimpleFIN sync: 3×/day (04:30, 12:30, 19:30 America/Chicago), plus the two mutations. Rules first, Haiku fallback for the rest, pending → posted in place (amount included), auto-links posted rows to schedules and rolls `nextDate`, upserts today's balance snapshot per account, syncs positions for invested accounts, writes a sync log |
| `lib/ops/finance.ts` | `get_finance_summary` (+ per-account buffer / projected low, last sync), `get_finance_budget` (month / quarter / year / last3, cadence filter), `list_finance_transactions` (`categories` = any of), `update_finance_transaction` (with `rememberPattern` → rule), `save_finance_budget`, `list_finance_schedules`, `save_finance_schedule` (`markPaid`), `list_finance_goals`, `save_finance_goal` (`fundingAccountIds`, `milestones`), `list_finance_holdings`, `list_finance_categories` (rules + budget lines + created ones), `list_finance_spend_groups`, `save_finance_spend_group` — Janet, the API, `hh`, the pages' writes and the phone |
| `lib/ops/net-worth.ts` | `get_net_worth`, `list_finance_loans`, `simulate_loan_payoff`, `save_finance_asset`, `save_finance_loan`, `record_loan_payment` (see Net worth below) |
| `mobile/app/(tabs)/finance/` | Phone (its own bottom tab since 2026-11-23, a stack under `_layout.tsx`): overview (+ Sync now), transactions (search, month, account, category, uncategorized; edit / itemize / remember), budget (period + cadence chips; change amount or end a line), scheduled (add / edit / mark paid), goals (edit + milestones), accounts (balances, holdings, SimpleFIN connection + last sync; a ⋯ menu per account: edit, view transactions, sync just that account (`syncFinance(accountId)`), delete; add / edit / link / delete via `AccountFormModal`, writing `homeFinanceAccount` directly through `lib/finance/account-form.ts`, the same code as the web form). Everything else through the ops; sheets in `mobile/components/finance/` |
| `pages/finance/` | Overview, Net worth, Loans (detail), Transactions, Budget, Review, Scheduled, Goals, Groups, Accounts (+ detail; each card has a ⋯ menu: edit, view transactions, sync just that account via `runFinanceSync(accountId)`, import CSV, delete), Rules. Frame and shared bits in `components/finance/` |

## Personal budgets: ledgers (2026-11-16)

Each adult (a household member with a login) has a personal budget next to
the household's; `lib/finance/ledger.ts`. Everyone sees every ledger.

- **Whose money.** An account with no owner or several is the household's;
  one owner makes it theirs (`accountLedger`). A transaction counts in its
  account's ledger unless `homeFinanceTransaction.ledger` says otherwise
  ("household" or a person id); an itemized charge can send each item
  elsewhere (`lineItems[].ledger`, else the charge's). Set in the
  transaction window ("Counts in", per item too), bulk edit, or Janet
  (`update_finance_transaction` `ledger`, items' `ledger`).
- **The math doesn't change.** Each ledger's budget is `householdBudget`
  over that ledger's slice of every transaction (`sliceForLedger`: whole,
  cut down to its items, or nothing) and that ledger's lines
  (`homeFinanceBudget.ledger`, null = household). Category exclusivity is
  per ledger: Groceries can be in the household's budget and in someone's
  own. Scheduled transactions count in their account's ledger.
- **Paid personally for the household = contribution.** Household spending
  on a personal account adds to that person's household contribution
  (received), and personal spending from joint money subtracts
  (`inKindContributions`; `paidDirectly` in the view, "incl. $X paid
  directly" on the line). A personal view shows `toHousehold`: their
  contribution line(s) as the plan, transfers in + paid directly as sent,
  and the plan comes out of what they have left to allocate. A personal
  INCOME line is their own income (paychecks; a personal slice with no
  person is the owner's).
- **A transaction's person is only a contributor.** `personId` means who
  put money in (a Contribution from an account not linked here); spending
  has no person, its owner is the ledger. The sync, the rules re-apply and
  `update_finance_transaction` only set it on money in. A transfer the sync
  paired between someone's own account and a household one needs no person:
  money into the household account counts as the source account owner's
  contribution, money back out against it (`inKindContributions`, counted on
  the household side only).
- **Everything** (`allLedgersBudget`) shows the ledgers side by side: every
  line measured in its own ledger, personal income only (the household's
  contribution lines are money between ledgers, as are Contribution rows in
  the review).
- Where: Budget and Review have Household / person / Everything tabs
  (`components/finance/ledger-tabs.tsx`, `?ledger=`), Transactions a
  "Budget" filter and a chip on rows that count somewhere other than the
  household; Overview and `get_finance_summary` are the household's;
  `get_finance_budget` takes `ledger` (name, id, household, all) and lists
  them; the phone's budget has ledger chips.

## Budgets for a stretch of dates, and sub-categories (2026-11-17)

For baby prep until the birth: "$3,000 on furniture, Nov 17 – May 27", no
monthly pacing.

- A one-off (`period: ONCE`) spending line **with an end date** is a span
  line (`isSpanLine`, lib/finance/budget.ts): one amount for those dates,
  measured against everything spent in its categories between them
  (`spanLineView`). It shows in every period it overlaps, under "For a
  stretch of dates" (`spanViews`; `get_finance_budget`'s `spans`), and is
  kept out of the period's totals (allocated, spent on lines, overspend).
  Over = spent past the amount; there's no pace. A one-off line without an
  end date still belongs to the period it starts in.
- Callers must load transactions back to the start of the span lines shown:
  `budgetTxRange(lines, window)`. Everything else in the budget filters to
  the window itself, so the extra rows don't leak into the month.
- Editing a span line keeps its own dates (web: the modal opens on them, so
  saving corrects it in place; phone: `versionId`), never "change from a
  date", which would split it.
- Sub-categories are plain category names "Parent: Child" ("Baby:
  Furniture"; `categoryCovers` / `coveringCategory` in categories.ts). A line
  on the parent covers its sub-categories; a line naming a sub-category
  takes it over (most specific wins, `rollUpCategories`), so nothing counts
  twice among the period's lines. The transaction filters (web and
  `list_finance_transactions`) match sub-categories under a parent. A new
  sub-category exists as soon as a budget line or a transaction uses it.

## Creating categories and spend groups from the transaction editors (2026-11-23)

Every place a transaction is edited (web: the row's category popover, the
edit window, its item rows, bulk edit, Add; phone: the transaction sheet)
can make a new category or spend group without leaving it.

- **Categories** are still plain names on the rows. Typing one the list
  doesn't have offers "Create “…”" ("Parent: Child" makes a sub-category,
  and the parent comes along). `update_finance_transaction` remembers any
  category it hasn't seen (charge or items, case-insensitive) in the
  finance setting `categories` and returns them as `newCategories`, so it
  stays in every picker after the row scrolls away: the vocabulary is
  rules + budget lines + that list (`lib/finance/category-list.ts`, read by
  `useFinanceRefs` and `list_finance_categories`). The web Add writes the
  model directly, so it calls `rememberCategories` itself.
- **Spend groups:** the group picker ends in "New group…" (web
  `components/finance/spend-group-picker.tsx`; phone "New group" chip in
  `mobile/components/finance/SpendGroupField.tsx`): name, kind, optional
  dates (web) and budget, saved through `save_finance_spend_group` (refuses
  a duplicate name; checks in `lib/finance/spend-groups.ts`, also used by
  /finance/groups) and picked. The phone sheet gained the spend group field
  it lacked, and its rows show the group, like the web.
  `update_finance_transaction` now refuses a spendGroupId that doesn't exist.

**Spend groups count in the budget (2026-11-23).** A tagged transaction
adds up to its group's total and still counts in the monthly budget under
its category (Seattle's hotel is in Travel for November and in "Seattle Nov
2026"). Before, tagging took a row out of the budget. A group can opt out
with "Keep out of the monthly budget" (`homeFinanceSpendGroup.keepOutOfBudget`,
for a remodel paid from savings); the budget code reads a copy on each row,
`homeFinanceTransaction.outOfBudget`, so it needs no group lookup. The copy
is written by `update_finance_transaction` when spendGroupId changes, by
`save_finance_spend_group` on every save of a group (all its rows), and by
the web Add; a new write path that sets spendGroupId must set it too. The
Groups page now saves through `save_finance_spend_group` (which gained
tripId and notes).

**Category tree (2026-11-23).** Finance categories are managed like
inventory's: `homeFinanceCategory` (name, parentId, sortOrder) is the tree,
edited in the Categories window (Transactions, Budget and Rules pages;
`components/finance/category-manager.tsx`): add, add a sub-category,
rename, move (Inside…), delete (its rows move to a chosen category, its
parent, or Uncategorized; sub-categories move up). Rows still store the
category as its path text, "Parent: Child", so nothing that reads
categories changed; `save_finance_category` / `delete_finance_category`
rewrite the path on every transaction, itemized line, rule, budget line
(all versions), schedule, invoice and the legacy `categories` setting
(`rewriteCategories` in `lib/finance/category-tree.ts`). The vocabulary is
the tree in tree order, then anything else rules or budgets name;
`rememberCategories` adds typed names to the tree. Pickers (web
`CategoryInput`, phone `CategorySheet`) list in tree order with
sub-categories indented, search any words of the path, and read
"Parent > Child" as "Parent: Child". Names can't contain ":" or ">".
`scripts/finance-categories-backfill.ts` filled the tree from the
categories in use. The sync's LLM fallback still picks from the rules'
categories only (so a trip's sub-category never catches unrelated charges).

**Rules set the budget too (2026-11-23).** A category rule can say whose
budget matching spending counts in (`homeFinanceCategoryRule.ledger`,
"Counts in" on the Rules page): H-E-B on Cristine's card → household, a
subscription on the joint card → Gennaro. `classify` returns it (first rule
with a ledger wins, independent of category/person), and the sync, the CSV
import and Re-apply write it with `ledgerSource: "RULE"`.
`homeFinanceTransaction.ledgerSource` says who set a row's ledger: MANUAL
(`update_finance_transaction`, never overridden), SCHEDULE (its bill: the
sync, `applyScheduleLinks`, the web Link dialog), RULE. Precedence is hand >
bill > rule > account: `canTakeScheduleLedger` lets a bill replace a rule's
budget, `canTakeRuleLedger` never touches MANUAL or SCHEDULE (rows from before
the field keep a non-account ledger as a choice). "Remember for similar" puts
the budget picked in the same edit on the new rule.

**Everything spent, and the income gap (2026-11-23).** "Spent in total" on
the budget opens Transactions filtered to `dir=spending` for that budget
and period: money out as the budget counts it (posted, not transfers / card
payments / income, not in a spend group kept out of the budget), the
`spending` direction in `lib/finance/tx-filter.ts` (also on the phone and
`list_finance_transactions`). Its total matches the card (checked against
prod, Nov 2026). The planned-income card says what's still to come (or
short, once the period is over) or the surplus.

**Budget drill-in (2026-11-23).** On /finance/budget every spending line,
every line for a stretch of dates and every "Not budgeted" category opens
to its transactions (`components/finance/budget-tx-list.tsx`), each with
its category as a chip that recategorizes in place through
`update_finance_transaction` (the row is patched locally, so the budget
recomputes and a recategorized row moves to its new line); itemized
charges link to Transactions, plus a "See them in Transactions" link with
the same categories and dates. The phone's "Not budgeted" rows already
open Transactions filtered to the category, where rows are edited.

## Net worth: assets and loans (2026-11-16)

Ported from gennaroanesi.com (`financeAsset`, `financeLoan`,
`financeLoanPayment`), reshaped:

- **Net worth** = active accounts (cash, invested, debts: loans and cards are
  negative balances) + active assets' current value
  (`lib/finance/net-worth.ts`). The history series reads the daily
  `homeFinanceAccountSnapshot` rows (each account's latest on or before the
  date) plus asset valuations as a step function; it starts on the first
  snapshot, since balances before it are unknown. Today's point uses live
  balances.
- **Assets** (`homeFinanceAsset`): house, cars, collectibles. Every value set
  is a `homeFinanceAssetValuation` row (PURCHASE / ESTIMATE / APPRAISAL /
  SALE; one per day, a second the same day corrects it); `currentValue` +
  `valuedOn` mirror the latest. Selling = `soldDate` + `soldValue`, which
  takes it out of net worth from that day without losing the history.
- **Loans** (`homeFinanceLoan`): the terms only. **The balance is the LOAN
  account's `currentBalance`**, never a cached copy: SimpleFIN keeps the Chase
  mortgage current; a manual one (the BMW) moves by each recorded payment's
  principal (`record_loan_payment`, which also moves it back on edit /
  delete). gennaroanesi.com cached `originalPrincipal − Σ principal` on the
  loan and needed "correction" payments when it drifted from the lender;
  here a manual balance is just corrected (`save_finance_loan owed`). One loan
  per account; the loan mirrors its rate into the account's `apr`.
- **Schedule** is computed (`lib/finance/loans.ts`): contractual P&I from the
  terms (or `monthlyPayment` when the lender's differs), payment dates on the
  first payment's day of the month (clamped in short months), the contract's
  expected balance today, payoff at the current payment, months ahead /
  behind. gennaroanesi.com stored one SCHEDULED row per month (360 for the
  mortgage) and posted them; here `homeFinanceLoanPayment` holds only
  payments actually made (P / I / escrow / fees, `isExtra`).
- **Connection**: `loan.assetId` = what secures it (mortgage → Home, auto →
  the car). Equity = value − what its loans owe, plus loan-to-value. Set from
  the loan's editor (or `save_finance_loan assetId / assetName`); removing an
  asset unlinks its loans.
- **What-ifs** (`simulate_loan_payoff`, the loan page's simulator): extra per
  month, a lump sum, a different payment, or "paid off by" → the payment
  needed; months and interest saved vs the current payment.

### Last day of the month (2026-11-16)

`homeFinanceRecurring.lastDayOfMonth`: a monthly / quarterly / … schedule
due on each month's last day instead of its start date's day
(`monthlyAnchor` in `lib/finance/dates.ts` anchors it to a 31st, which
`addMonthsAnchored` clamps). Honored everywhere the schedule's dates are
computed: the sync's roll-forward, mark-paid, projections, the budget's
occurrence counts, the week plan and the review page. `save_finance_schedule
lastDayOfMonth` moves `nextDate` to that month's end; a switch on the bills
form and on the loan editor's new-schedule option.

### Loan → payment → schedule → budget (2026-11-16)

Real links: `homeFinanceLoan.recurringId` (the bill), `homeFinanceTransaction.recurringId`
(set by the sync's match or by hand on the bills page), `homeFinanceLoanPayment.transactionId`
(set by the capture, kept by the lender import). The budget has no link: it
is category-driven, and a schedule's `category` is both its "committed"
share of a budget line and, since 2026-11-16, **the category a linked
transaction gets** (the sync's create and the bills page's manual link set
`category` + `categorySource: RULE` from the schedule, unless the row was
categorized by hand). So the schedule is where a recurring payment's budget
line is decided; use the canonical names ("Mortgage Payment", "Loan
Payment"). The household's two bills: Mortgage ($3,650, 1st, ends
2052-11-01) and BMW M850i ($2,000, last day of the month, ends with the
contract), both from Gennaro Chase Checking, patterns `/mortgage/i` and
`/bmw/i` (gennaroanesi.com's rules couldn't be read: its pool rejects both
local credential sets; tighten once the first payments post).

### Tracking payments against the lender (2026-11-16)

- **The lender's schedule is the source of truth for payments.** "Import
  lender schedule" on the loan page takes the lender's PDF (BMW FS's "actual
  amortization schedule", a servicer's payment history): upload kind `loan`
  (`/api/finance/upload-url`) → `parseLoanSchedulePdf` (paycheck-processor
  Lambda, Claude reads the rows: `lib/finance/loan-schedule-extract.ts`,
  rows whose split doesn't add up are flagged) → a preview → the
  `import_loan_payments` op. Rows match existing payments **by date**: a
  recorded one is corrected to the lender's split (`source: LENDER`,
  `estimated: false`, `paymentNumber`), others are added, nothing is
  deleted; a manual account's balance is set to the lender's figure (the
  last row's balance, or `owedAfter`). Re-importing the next letter is the
  manual sync; identical rows count as unchanged.
- **Daily simple interest** (`homeFinanceLoan.interestAccrual = DAILY`, the
  BMW; null = MONTHLY, the mortgage): estimated splits use the days since the
  previous payment (`interestDays` → `suggestSplit(…, days)`), which
  reproduces BMW FS's rows to the cent. A split that wasn't typed or imported
  is marked `estimated`.
- **The scheduled transaction that pays it** (`homeFinanceLoan.recurringId`;
  "Paid by" in the loan editor: pick a bill or create one from the terms,
  `save_finance_loan newSchedule` → monthly, P&I + escrow or the `amount`
  actually paid, next due on the next payment date (or `nextDate`),
  `lastDayOfMonth` for month-end payments, `matchPattern` for the sync,
  `endDate` at the contract's end). When the finance sync links a posted transaction to that schedule it
  also records the payment on the loan (`lib/finance/loan-capture.ts`,
  `source: BANK`, estimated split, `transactionId`; a payment already on that
  date just gains the link; a manual balance moves by the principal). The
  bills page shows a "Loan" chip on such a schedule. One schedule pays one
  loan.
- **Against the contract** (`compareToPlan`): each regular payment next to
  the contract's row with the same number (the lender's `paymentNumber`, else
  position in date order), extra principal per payment ("vs plan" column) and
  the running total ahead or behind (`principalAhead` on the op, a chip on the
  loan page). Extra payments add to the total without consuming a row.
- **The BMW** (2026-11-16, from BMW FS's letters): $106,622.78 at 5.49% over
  72 months, $1,745.48 contractual, first payment 2023-01-18, daily accrual;
  45 payments through 2026-10-23, balance $36,409.33, interest paid
  $15,568.75. Mostly $2,000 payments; no July 2026 payment (71 days of
  interest on #43). Import the November letter after the deploy; create the
  bill from the loan editor (the household has no scheduled transactions yet).

Ops (`lib/ops/net-worth.ts`): `get_net_worth` (`includeHistory`),
`list_finance_loans` (by id or name: "mortgage", "car", the asset or lender;
each loan carries `schedule`, `interestAccrual`, `principalAhead`),
`simulate_loan_payoff`, `save_finance_asset`, `save_finance_loan`
(`interestAccrual`, `recurringId`, `newSchedule`), `record_loan_payment`
(`paymentNumber`; estimated splits flagged), `import_loan_payments` (rows +
`owedAfter`, `source`). Pages: `/finance/net-worth` (headline, own vs owe
bar, history, property with equity, loans, accounts by group) and
`/finance/loans/[id]` (where it stands, simulator + balance chart, terms with
"paid by", payments by year with interest per year for taxes, "vs plan" and
estimated chips, import lender schedule, remaining schedule); the overview
has a net worth line, a LOAN account's page links to its loan. Phone: Finance
→ Net worth (read-only).

### Automatic market values (2026-11-16)

`homeFinanceAsset.valueProvider` + `lib/finance/asset-values.ts`:
- **RENTCAST** (the house): `GET api.rentcast.io/v1/avm/value?address=…`
  (`X-Api-Key`), `price` + `priceRangeLow/High`; needs `address` as
  "Street, City, State, Zip", and sends `bedrooms` / `bathrooms` /
  `squareFootage` when the asset has them (RentCast's own record had the
  house as 4bd; with 5bd/3ba/2,812 sq ft the comps matched and the estimate
  moved from $484k to $492k on 2026-11-16). Free plan 50 requests/month,
  which needs the free subscription activated on the RentCast dashboard
  (a key without it gets 403 `billing/subscription-inactive`); one a month
  is used.
- **MARKETCHECK** (a car): `GET api.marketcheck.com/v2/predict/car/us/marketcheck_price?api_key&vin&miles&zip&dealer_type=independent`
  → `marketcheck_price` (+ `msrp`); needs `vin`, `mileage` (`mileageDate`
  set when it changes; update it now and then) and `zip`. Free plan 500
  calls/month; whether price prediction is included on Free is unconfirmed
  (the user couldn't find VinAudit's free developer tier, so MarketCheck it is).
- **DEPRECIATION**: purchase price × (1 − `annualDepreciation`, default
  15%)^years, by the day. The no-key fallback for a car.
- **When:** the scheduled finance sync (3×/day) refreshes assets whose last
  auto valuation (notes start "Auto: ") is ≥ 28 days old, so about monthly;
  "Refresh values" on `/finance/net-worth` and the `refresh_asset_values`
  op (→ the `refreshAssetValues` mutation on the finance-sync Lambda) do it
  now, for all or one asset. Each refresh is an ESTIMATE valuation dated
  today (a same-day estimate is replaced) and mirrors onto `currentValue`
  unless a hand-entered value has a later date. One asset's failure doesn't
  stop the others; errors come back per asset.
- **Keys:** `RENTCAST_API_KEY`, `MARKETCHECK_API_KEY`: plain env vars on
  the finance-sync Lambda (`amplify/backend.ts`), read from `.env.local` for
  the sandbox and from **Amplify Hosting's environment variables for prod**
  (the build env is what `process.env` sees at synth). They must be added
  there, like `ANTHROPIC_API_KEY`.
- Williamson CAD's yearly appraised value still goes in by hand as an
  APPRAISAL. No parallel inventory records for the house or cars; an
  `inventoryItemId` link on the asset for things that are both (a watch,
  art) is still open.

Data came over with `scripts/import-gennaroanesi-loans.ts` (assets with a
purchase + today's valuation; the mortgage attached to the synced Chase
account; the BMW as a manual LOAN account at gennaroanesi.com's balance;
posted payments only; a `startDate` after the first payment, a data slip
there, is dropped). Re-run safe (markers in notes).

## Paychecks, tax outlook, invoices (2026-11-09)

Home-hub now owns paychecks (moved from gennaroanesi.com, which keeps its
copy until its pages are pointed here or retired).

| Where | What |
|---|---|
| `homePaycheck` | One row per stub per person (`personId`, not ME/SPOUSE), headline + YTD columns, `lineItems` JSON, `s3KeyPdf`, `source`, `importRef` |
| `homePaycheckInbox` | Emailed stubs waiting for review; Claude output never lands in `homePaycheck` unreviewed |
| `homeInvoice` / `homeInvoiceLink` | Household invoices and the transactions that paid them |
| `homeFinanceSetting` | JSON settings by key (`tax-outlook:<year>`) |
| `amplify/functions/paycheck-processor` | Email (S3 trigger) → inbox rows; `parsePaycheckPdf` mutation for uploads. A PDF can hold several stubs (Workday's "Payslip to Print" batches them, one per page): the extraction returns every stub with the pages it spans, each becomes its own inbox row / upload draft with its own cut of the PDF (`lib/finance/pdf-pages.ts`, pdf-lib), deduped by file hash + pages and by person + pay date + net. A re-sent batch only adds what was missed. The stub's employee name is matched to a finance person by `matchPerson` (lib/finance/paycheck-fields.ts: full name, first name, or the first 4–5 letters, so "Cris" takes "Cristine Marcon Borges"); no match leaves the row unassigned with a "pick the person" note. To re-run an email that failed (e.g. the Claude call errored), delete its ERROR inbox row (dismissed rows still count for the hash dedupe) and invoke the Lambda with an S3 ObjectCreated event for the raw email's key in the inbound mail bucket |
| `amplify/functions/invoice-processor` | Email (S3 trigger) or `ingestInvoicePdf` upload → `homeInvoice`, auto-links the one matching transaction; renders bodies without a PDF with Chromium (public layer) |
| `lib/finance/` | `inbound-mail.ts` (gate + MIME), `paycheck-extract.ts` / `invoice-extract.ts` (Claude, server-only), `paycheck-fields.ts` / `invoice-fields.ts` (browser-safe), `paychecks.ts` (contributions vs pay: "put in" is `householdContributions` from ledger.ts, the same number the household budget and Review show as received per person, so transfers and household spending from personal accounts count), `tax.ts` (projection, 401k caps, safe harbor), `finance-files.ts` (S3 layout) |

**Supplemental withholding.** Workday stubs print one federal line, so
`supplementalFedWh` / `ytdSupplementalFedWh` never come off a PDF; the
values on the imported rows were a running sum backfilled once in
gennaroanesi.com (federal withheld on each RSU- or bonus-only stub).
`tax.ts` (`ytdSupplementalFedWhOf`) derives the figure at read time: the
latest stub that records it, plus the withholding of any supplemental-only
stubs after it; with none recorded, those stubs' withholding; the IRS flat
22% only when nothing is known. Emailed stubs carry null and need no
backfill. The projection counts vests by stubs with `rsuGross`, so a vest
needs its own stub: a regular stub whose YTD columns already include a
vest nobody entered makes the page project one more.
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

**Connections (2026-11-15).** There is one SimpleFIN subscription per person,
listed in `lib/finance/simplefin-connections.ts` (`key`, `label`, Secrets
Manager `secretName`): Gennaro's is `home-hub/simplefin/gennaro`, a copy
(made 2026-11-15) of the token gennaroanesi.com keeps using in
`gennaroanesi/simplefin` (same AWS account; re-claiming the token means
updating both), Cristine's is `home-hub/simplefin/cristine`. Each secret
holds `{"accessUrl": "…"}`.
`homeFinanceAccount.simplefinConnection` says which connection an account's
`simplefinAccountId` belongs to (null = the first, for rows from before).
The Lambda reads the secrets at run time (15-minute cache), so a connection
whose secret doesn't exist yet shows "isn't set up yet" in the picker and the
sync log instead of failing the deploy; `backend.ts` only grants read on both
names. Adding a third person is a line in that file plus a secret.

Each token can see that person's own accounts too, so:

- the sync asks SimpleFIN once per connection, only for the ids mapped to it
  (`fetchAccounts` throws if called without ids unless `allAccounts` is set,
  and the handler drops anything it didn't ask for). A connection that fails
  is reported and skipped; the others still sync (status PARTIAL);
- the account picker (`listSimplefinAccounts`) uses `balances-only=1` and
  returns only id, institution, name and the connection key, grouped per
  person in the modal ("Gennaro's SimpleFIN" / "Cristine's SimpleFIN"), with
  a search box and filters (whose connection, institution, hide linked;
  `simplefinPickerGroups` in `lib/finance/account-form.ts`, shared with the
  phone).
  Anyone in `home-users` can see those names;
- SimpleFIN rate-limits per token. gennaroanesi.com pulls Gennaro's at
  roughly 4/12/19h Chicago; these runs are 30 minutes later. Cristine's token
  is only used here.

`scripts/setup-simplefin-connection.mjs --connection cristine --setup-token
<token>` claims a SimpleFIN Bridge setup token (one use) and stores the access
URL in the secret (never printed, only masked); `--check` lists the account
names a stored URL sees.

## Setting it up (once the joint account exists)

1. Deploy. Check the first scheduled run wrote a `homeFinanceSyncLog` row
   (status OK, 0 accounts) — or press *Sync now* on any finance page.
2. Add the bank connection in SimpleFIN Bridge, in whichever person's
   SimpleFIN subscription holds that bank login. For a connection that
   isn't stored yet (Cristine's), create a setup token there (New App) and
   run `scripts/setup-simplefin-connection.mjs --connection cristine
   --setup-token <token>` with `AWS_PROFILE=amplify-dev`.
3. *Finance → Accounts → Add*, type Checking, no owners (= joint), set a
   buffer (`minBalance`), then *Pick* the SimpleFIN account from the right
   person's list (this also sets the connection). *Sync now*.
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
- Phone: review, paychecks, invoices, rules, groups and tax outlook are web-only; new budget lines and manual transactions too.
- Budget rollover (`rollover` is stored but not applied; gennaroanesi.com
  freezes period rows for it in `financeBudgetPeriod`).
- Loans (mortgage / car amortization) if the payoff view is wanted here.
- `goalId` has no index; the Goals page loads all transactions to total
  tagged ones. Fine for one account, add an index if it gets slow.
