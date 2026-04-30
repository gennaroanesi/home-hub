# Home Hub

A self-hosted home-management app for a small household. Tracks tasks, bills, calendar events, shopping lists, photos, documents, devices, reminders, and trips. Talks to a Claude agent ("Janet") via web and WhatsApp for natural-language interactions.

> **Status:** built for one specific household. Published in case any of it is useful as a reference. **No support, no guarantees, no SaaS.** If you fork, expect to read code and patch a few things.

## Stack

- **Frontend:** Next.js (Pages Router) + HeroUI + Tailwind
- **Backend:** AWS Amplify Gen 2 (AppSync + DynamoDB + Lambda)
- **AI agent:** Anthropic Claude via direct API
- **WhatsApp bot:** ECS Fargate + [Baileys](https://github.com/WhiskeySockets/Baileys) (linked-device pairing, not WA Business API — needed for group chat support)
- **Notifications:** SNS (SMS) + Expo push (mobile app)
- **Optional integrations:** Home Assistant (devices), Duo Push (HIGH-sensitivity actions), Adobe Lightroom (photo import), AWS Rekognition (face tagging)

## Prerequisites

- AWS account in `us-east-1` (other regions need code edits — Cognito, Rekognition collection ID, Bedrock if you switch off Anthropic API)
- Node 20+
- An Amplify CLI profile pointing at that account (e.g. `amplify-dev`)
- Anthropic API key (Bedrock not used)
- An S3 bucket for the `home/*` prefixes (can be a dedicated one or shared with another site as long as the prefix is yours)
- (optional) Home Assistant + a Nabu Casa URL or other public HTTPS endpoint
- (optional) Duo Auth API integration (paid plan required)
- (optional) WhatsApp account to link as a bot (a second number, not your personal one)

## Required env vars

Create `.env.local` at the repo root:

```bash
# Anthropic (required for the agent + daily summary)
ANTHROPIC_API_KEY=sk-ant-...

# S3 bucket holding home/* prefixes (photos, documents, agent uploads, etc.)
HOME_HUB_BUCKET=your-bucket-name

# WhatsApp group JID for the household chat (only required if using the bot)
# Format: <digits>@g.us — see whatsapp-bot/README for how to find it
WHATSAPP_GROUP_JID=000000000000000000@g.us

# Random shared secret for the /api/whatsapp-qr endpoint
QR_ACCESS_TOKEN=$(openssl rand -hex 32)
```

## Optional env vars

```bash
# Home Assistant integration
HASS_BASE_URL=https://xxx.ui.nabu.casa
HASS_TOKEN=<long-lived access token>

# Adobe Lightroom import (only if you use scripts/lightroom-import.mjs)
ADOBE_CLIENT_ID=...
ADOBE_CLIENT_SECRET=...
LIGHTROOM_REFRESH_TOKEN=...
```

For the Amplify Hosting deploy, the same `HOME_HUB_BUCKET`, `HASS_BASE_URL`, and `HASS_TOKEN` need to be added under **App settings → Environment variables**. They're forwarded to the SSR runtime via `amplify.yml` preBuild.

## Setup

```bash
# Install (the .npmrc forces --legacy-peer-deps)
npm install

# Backend sandbox (your own personal CloudFormation stack)
npx ampx sandbox --profile amplify-dev

# In another terminal: frontend
npm run dev
```

The sandbox writes `amplify_outputs.json` (gitignored) which the frontend reads.

## First user

Cognito self-signup is **disabled** — accounts are admin-only. Use the included script:

```bash
npm run create-user -- --env dev --email you@example.com --name "Your Name"
```

(Use `--env prod` to target the deployed user pool instead of the local sandbox.) The script creates the user, adds them to the `home-users` group, and creates a matching `homePerson` row.

## WhatsApp bot

`whatsapp-bot/` is an ECS Fargate service that runs Baileys to pair with a WhatsApp account as a linked device. The container image is built by an in-stack CodeBuild project triggered from `amplify.yml`'s postBuild step. The service starts at `desiredCount: 0` until you push the first image, then ramp it to 1.

Pairing flow: deploy → bump `desiredCount: 1` → wait for the task to start → open `https://your-app/api/whatsapp-qr?token=$QR_ACCESS_TOKEN` in a browser to render the QR → scan from your phone's WhatsApp (Settings → Linked Devices → Link Device) → bot stores the auth state in S3 (`s3://$HOME_HUB_BUCKET/whatsapp-bot/auth/`) and reuses it on every restart. The `?token=` query string is required — the route 401s without it.

## Home Assistant integration

Optional. See [docs/home-automation-plan.md](docs/home-automation-plan.md) for the design (Nabu Casa over Cloudflare Tunnel rationale, Hyper-V/WSL2 notes, sensitivity tiers, etc.). When `HASS_BASE_URL` + `HASS_TOKEN` are set, `hass-sync` Lambda mirrors devices into the `homeDevice` table every 5 min and the agent's `control_device` tool becomes usable.

## Lightroom import

Optional. See [docs/lightroom-import.md](docs/lightroom-import.md). The script-based import flow exists because Adobe's web-app credential requires HTTPS, so the OAuth callback is hosted by the deployed app even though the import runs locally.

## Architecture pointers

- [amplify/data/resource.ts](amplify/data/resource.ts) — full GraphQL schema (every model, every auth rule)
- [amplify/backend.ts](amplify/backend.ts) — IAM, env vars, ECS bot stack, EventBridge schedules
- [amplify/functions/agent/handler.ts](amplify/functions/agent/handler.ts) — the Claude agent and all its tools (~4000 lines, the heart of the app)
- [amplify/functions/daily-summary/handler.ts](amplify/functions/daily-summary/handler.ts) — Haiku-composed morning briefing
- [amplify/functions/reminder-sweep/handler.ts](amplify/functions/reminder-sweep/handler.ts) — every-5-min reminder dispatcher
- [whatsapp-bot/src/index.ts](whatsapp-bot/src/index.ts) — Baileys glue + agent invocation pipeline
- [ROADMAP.md](ROADMAP.md) — what's planned next

## Security model

- All `homeXxx` GraphQL models gate on `allow.group("home-users")` — Cognito group membership is the universal access check
- All `pages/api/**` routes (except `whatsapp-qr`, `lightroom/callback`, `d/[key]`) require a Cognito session in the `home-users` group via `lib/api-auth.ts`
- HIGH-sensitivity device actions and document downloads require Duo Push approval
- Cognito self-signup is disabled; accounts are admin-only
- Secrets: `ANTHROPIC_API_KEY` from env, Duo Auth API key from Secrets Manager (`home-hub/duo-auth-api`), `HASS_TOKEN` from env

## License

No license — all rights reserved. You may read and adapt for personal use; no warranty, no support, no commercial use without permission.
