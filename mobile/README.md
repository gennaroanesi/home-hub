# Home Hub — mobile

iOS-only Expo app that hits the same Amplify backend as the Next.js
web app. Shares `amplify_outputs.json` and the generated `Schema`
types from the repo root, so the data layer is in lockstep.

## Phase status

- **Phase 0** *(current)* — auth, push token registration, EAS config.
- Phase 1 — tasks, shopping, calendar.
- Phase 2 — agent chat, reminders.
- Phase 3 — devices + local Home Assistant discovery.
- Phase 4+ — photos, trips, notes, documents, checklists, security, admin.

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
