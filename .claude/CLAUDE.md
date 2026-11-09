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
- Recurring tasks: on-completion creates next occurrence + daily EventBridge sweep as safety net
- WhatsApp bot uses Baileys (not official WA Business API) because it needs group chat support
- WA bot desiredCount is 0 until first Docker image is pushed to ECR
- Finance (`/finance`, `docs/finance-handoff.md`) reuses gennaroanesi.com's SimpleFIN token (`gennaroanesi/simplefin`); the sync must only request mapped account ids, since the token also sees personal accounts
- Bills are scheduled transactions (`homeFinanceRecurring`); `homeBill` was removed
- Paychecks live here now (`homePaycheck`, moved from gennaroanesi.com). Emailed stubs/invoices go to `paychecks@` / `invoices@import.cristinegennaro.com`; only senders in `FINANCE_INBOUND_ALLOWED_SENDERS` (with DKIM/SPF pass) are processed. SES receipt rules live in the account's single active rule set, shared with other apps: change them only via `scripts/setup-finance-inbound-email.sh`
- Amplify's model client can't run secondary-index queries on our lowercase model names; use raw GraphQL (`txIndexQuery` in `lib/finance/data.ts`)

## Dev
- `npx ampx sandbox --profile amplify-dev` to run backend locally
- `npm run dev` for frontend (port 3001)
- `.env.local` holds `ANTHROPIC_API_KEY`
- `npm install` requires `--legacy-peer-deps` (handled by `.npmrc`)
