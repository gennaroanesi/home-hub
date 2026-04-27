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

```bash
cd mobile
npx expo start
# press i to open the iOS simulator
```

The simulator can sign in but cannot register an Expo push token —
push only works on a physical device. To exercise the full pipeline,
build a development client with EAS and install on a real iPhone:

```bash
npx eas-cli login                         # one-time
npx eas-cli build:configure              # one-time, links Expo project
npx eas-cli build --profile development --platform ios
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
