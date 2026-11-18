# Home Hub

Home management app for a two-person household.

## Stack
- **Frontend**: Next.js (Pages Router) + HeroUI + Tailwind CSS
- **Backend**: AWS Amplify Gen 2 (AppSync, DynamoDB, Lambda)
- **AI Agent**: Anthropic Claude via direct API (not Bedrock)
- **Notifications**: SNS topic (SMS subscriptions added manually in AWS Console)
- **WhatsApp Bot**: ECS Fargate + Baileys (linked device approach)

## AWS
- Amplify App ID, region, and S3 bucket name come from local sandbox config / Amplify Hosting env vars (not committed).

## Key decisions
- Auth uses Cognito `home-users` group for all home models
- Agent Lambda invoked via AppSync custom mutation (not Lambda Function URL — blocked by account-level public access policy)
- Recurring tasks: on-completion creates next occurrence + daily EventBridge sweep as safety net. The open `homeTaskOccurrence` is the source of truth and `homeTask.dueDate` mirrors it; anything that changes a recurring task's date must go through `taskOccurrenceAction` RESCHEDULE (`rescheduleIfMoved` in lib/task-actions.ts)
- WhatsApp bot uses Baileys (not official WA Business API) because it needs group chat support
- WA bot desiredCount is 0 until first Docker image is pushed to ECR
- Finance (`/finance`, `docs/finance-handoff.md`) has one SimpleFIN connection per person (`lib/finance/simplefin-connections.ts`: `home-hub/simplefin/gennaro` is a copy of gennaroanesi.com's `gennaroanesi/simplefin` token, Cristine's is `home-hub/simplefin/cristine`), read from Secrets Manager at run time; `homeFinanceAccount.simplefinConnection` says whose. The sync must only request mapped account ids per connection, since each token also sees that person's own accounts
- Invested accounts (BROKERAGE / RETIREMENT: 401k, IRA) sync balance, positions (`homeFinanceHolding`) and transactions, but their transactions aren't household cash flow: anything budget-like reads `householdAccounts()` / `listTransactions`' default, which leave them out. They feed goals, not the budget
- Net worth (`/finance/net-worth`, docs/finance-handoff.md): a loan's balance is always its LOAN account's `currentBalance` (SimpleFIN or recorded payments), never cached on `homeFinanceLoan`; schedules are computed, only real payments are stored; `loan.assetId` links a loan to the asset it secures (equity). The lender's own schedule is the truth for payments (`import_loan_payments`, matched by date, lender wins); `loan.recurringId` is the bill that pays it, and the sync records a payment (estimated split, `source: BANK`) when it links a transaction to that bill; `interestAccrual: DAILY` loans estimate interest by days. Asset values are a `homeFinanceAssetValuation` history; `currentValue` mirrors the latest; `valueProvider` (RentCast / MarketCheck / depreciation, lib/finance/asset-values.ts) refreshes it monthly from the finance-sync Lambda, whose `RENTCAST_API_KEY` / `MARKETCHECK_API_KEY` come from the Amplify Hosting build env
- Budgets are per ledger (`lib/finance/ledger.ts`): the household plus one per adult. Joint/unowned accounts are the household's, single-owner accounts their owner's; `homeFinanceTransaction.ledger` and line items' `ledger` override. Anything budget-like goes through `ledgerBudget` / `txsForLedger`, never `householdBudget` over raw transactions. Household spending paid from a personal account, and transfers from it into a household account, count as that person's contribution. `homeFinanceTransaction.personId` is only the contributor on money in; never use it for whose spending something is. A one-off line with an end date is one amount for those dates (`isSpanLine`, outside the period totals; load txs with `budgetTxRange`); sub-categories are "Parent: Child" and a parent's line covers them (`coveringCategory`)
- Bills are scheduled transactions (`homeFinanceRecurring`); `homeBill` was removed
- Paychecks live here now (`homePaycheck`, moved from gennaroanesi.com). Emailed stubs/invoices go to `paychecks@` / `invoices@import.cristinegennaro.com`; only senders in `FINANCE_INBOUND_ALLOWED_SENDERS` (with DKIM/SPF pass) are processed. SES receipt rules live in the account's single active rule set, shared with other apps: change them only via `scripts/setup-finance-inbound-email.sh`
- People: `homePerson` holds both the household (app users, `home-users` group, `/admin/people`) and the contact book (`/contacts`); household = the group (lib/household.ts), never cognitoUsername or a phone number. New logins only via the admin Invite (`invitePerson`; Cognito self sign-up is off). Kids join the household without a login (Invite → "No login": `home-users` in `homePerson.groups` only); "both" means the members with a login. Links between people are `homePersonRelationship`, one row per pair with the inverse derived (lib/relationships.ts), never stored twice. Businesses / service people are `homeBusiness`; health providers stay in `homeHealthProvider` (visits point at them) and are only listed alongside
- Week planner (`/week`, `docs/week-planner.md`): one computed read, `get_week_plan`, shared by web, mobile, Janet and the Sunday WhatsApp nudge (`week-review` Lambda); feed events can be assigned to people and keep it across ics-sync
- Trip prep (`lib/trip-prep.ts`): checklist templates with `autoAttachTrips` are copied onto every trip (once, by `sourceTemplateId`), and a `trip-departure` reminder fires 5h before the first leg departs (leg wall clock read in its origin's timezone), listing what's still unchecked. `ensureTripPrep` runs after every trip/leg save (web, phone, Janet) and hourly from reminder-sweep for upcoming trips; a new trip/leg write path should call it too
- Files under `home/` reach people only as signed links: `/api/d/...?t=` (`lib/file-link.ts`, 15 min, redirects to a presigned S3 GET) or the document content/approval endpoints. Never hand out bare S3 URLs or unsigned `/api/d` links; the bucket only allows those from the home IP
- Amplify's model client can't run secondary-index queries on our lowercase model names; use raw GraphQL (`txIndexQuery` in `lib/finance/data.ts`)

## Dev
- `npx ampx sandbox --profile amplify-dev` to run backend locally
- `npm run dev` for frontend (port 3001)
- `.env.local` holds `ANTHROPIC_API_KEY`
- `npm install` requires `--legacy-peer-deps` (handled by `.npmrc`)
