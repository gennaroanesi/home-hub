# Home Hub — mobile

iOS-only Expo app that hits the same Amplify backend as the Next.js
web app. Shares `amplify_outputs.json` and the generated `Schema`
types from the repo root, so the data layer is in lockstep.

## Phase status

- Phase 0 — auth, push token registration, EAS config.
- Phase 1 — tasks, shopping, calendar.
- Phase 2 — Janet agent chat, reminders.
- **Phase 3** *(current)* — Home tab + local-network HA discovery.
- Phase 4 — photos.
- Phase 5+ — trips, notes, documents, checklists, security, admin.

## Home Assistant credentials

The Home tab calls HA directly. Set the URL + long-lived token via
build-time env vars rather than typing them in the app:

```bash
# Local dev — copy and fill in:
cp mobile/.env.example mobile/.env.local
# edit values; .env.local is gitignored
```

For EAS builds:

```bash
npx eas-cli secret:create --scope project --name EXPO_PUBLIC_HA_BASE_URL --value "https://..."
npx eas-cli secret:create --scope project --name EXPO_PUBLIC_HA_TOKEN --value "eyJ..."
```

The settings screen (More → Home Assistant) auto-detects env-managed
mode and shows a read-only state in that case. Without env vars it
falls back to a manual input form storing values in `expo-secure-store`.

## Run locally

There are two paths — pick based on what you're testing.

### Simulator (fastest, no push)

```bash
cd mobile
# 1. build a sim-only dev client once (cached after first run)
npx eas-cli build --profile development-simulator --platform ios
# 2. start Metro
npx expo start
# 3. press `i` to open the simulator + load the bundle
```

`expo-notifications` refuses to mint Expo push tokens on simulators,
so the dashboard will show "Push not registered" — everything else
(sign-in, data, agent) works.

### Physical iPhone (required for push pipeline)

One-time, register the device with EAS:

```bash
npx eas-cli device:create
# follow the link / QR on the iPhone, install the provisioning profile
```

Then build and install:

```bash
npx eas-cli build --profile development --platform ios
# scan the QR with the iPhone's camera or open the link to install
npx expo start
# the dev client picks up Metro automatically over the local network
```

## Test the push pipeline

Once a device has registered (a row appears in `homePushSubscription`):

```bash
node ../scripts/send-test-push.mjs
node ../scripts/send-test-push.mjs --person <homePerson.id>
```

## Architecture notes

- `lib/amplify.ts` — single Amplify configure call, lazy-init data client.
- `lib/auth.ts` — `useAuthSession()` hook, sign-in / sign-out helpers.
- `lib/push.ts` — permission request, Expo token fetch, upsert into
  `homePushSubscription` keyed on (personId, deviceLabel).
- `lib/current-person.ts` — Cognito user → `homePerson` lookup. The
  web app has a fuzzy fallback for legacy users; the mobile app
  requires an explicit `cognitoUsername` link.
