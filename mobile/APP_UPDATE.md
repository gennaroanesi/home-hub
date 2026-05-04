# App update workflow

How to ship changes to the iOS app (TestFlight + production). Two paths,
chosen by what kind of change you're shipping:

| Change touches… | Path | Time | Apple review |
| --- | --- | --- | --- |
| Only JS / React / TS code | OTA update via EAS Update | ~10 sec | None |
| Native (deps with native code, plugins, app.json iOS/Android settings, SDK bump) | New build via EAS Build → Submit → TestFlight | ~30 min | Re-review only for App Store; TestFlight bypasses |

## Setup (one-time)

EAS Update is configured in `app.json` and `eas.json`. The next prod
build picks it up automatically; nothing else to do.

```bash
cd mobile
npx eas-cli build --profile production --platform ios
npx eas-cli submit --profile production --platform ios --latest
```

After this build is in TestFlight, OTA is live.

## Day-to-day

### JS-only change → OTA

```bash
cd mobile
npx eas-cli update --branch production --message "Short description of the change"
```

Existing TestFlight installs pick it up on the next cold launch (+ a
brief pause as the new bundle downloads). No new build, no Apple
processing, no TestFlight invite re-issue.

The `--branch` corresponds to the build profile that produced the app:

| Build profile | Update branch |
| --- | --- |
| `production` (TestFlight + App Store) | `production` |
| `preview` (internal sharing) | `preview` |
| `development` (custom dev client) | `development` |

### Native change → fresh build

Anything in this list = native, needs a build:

- New dependency installed via `expo install` that ships native code
  (e.g. `expo-sharing`, `expo-file-system`, anything with an iOS pod)
- Plugin added/removed/reconfigured in `app.json`'s `plugins` array
- iOS / Android settings in `app.json` (entitlements, `infoPlist`,
  permissions, bundle ID, scheme)
- Expo SDK bump
- Anything under `mobile/plugins/` (custom config plugins)

Steps:

1. **Bump `expo.version` in `app.json`** (e.g. `1.0.0` → `1.0.1`). This
   rolls the runtime version. OTA updates stop flowing to the previous
   build, which prevents crashes from JS that calls native code the
   installed app doesn't have.
2. Build + submit:
   ```bash
   cd mobile
   npx eas-cli build --profile production --platform ios
   npx eas-cli submit --profile production --platform ios --latest
   ```
3. After Apple processes the build (~15-30 min), TestFlight users get
   it on next refresh of the TestFlight app. From there, OTA updates
   for the new version flow normally.

### Mixed change (native + JS)

Same as native. The new build's bundle includes the latest JS, so don't
separately push an OTA right after the build — the build IS the OTA
snapshot for the new runtime.

## How to tell what kind of change you have

| Path | Verdict |
| --- | --- |
| `mobile/app.json` (plugins, ios.*, android.*, version) | Native — bump version + build |
| `mobile/package.json` (any new dep with native code) | Native — bump version + build |
| `mobile/plugins/**` | Native — bump version + build |
| `mobile/app/**/*.tsx`, `mobile/components/**`, `mobile/lib/**` | JS-only — OTA |
| `pages/**`, `components/**`, `lib/**`, `amplify/**` | Web/server — Amplify Hosting redeploys, no mobile action |
| `whatsapp-bot/**` | Bot — Amplify Hosting build pushes new Docker image, no mobile action |

When in doubt, just bump the version and build. OTA failures are
silent (the JS just crashes on the user's device); a build is
foolproof.

## Useful commands

### List published updates

```bash
npx eas-cli update:list --branch production
```

Shows every published update with id, message, runtime version,
publish time, and which builds got it.

### Roll back a bad update

If a published update breaks the app:

```bash
npx eas-cli update:rollback --branch production
```

Republishes the previous update as the latest. Affected users get the
old (working) bundle on next foreground.

Alternative: republish a specific older update by id:

```bash
npx eas-cli update:republish --branch production --group <update-group-id>
```

### Verify your build is OTA-ready

After a fresh build is installed on a device:

```bash
npx eas-cli build:list --platform ios --limit 1
```

Confirms the build's runtime version. If it matches what
`npx eas-cli update:list` shows for the latest update on the same
branch, OTA will reach it.

## Gotchas

- **OTA only ships JS.** New native deps in a JS-only commit will
  crash on launch. The runtime version policy (`appVersion`) protects
  against this only if you remember to bump the version when adding
  native code. **Always bump version on native changes.**
- **Updates apply on cold launch**, not in-foreground. To test an
  update locally on a TestFlight build: kill the app from the
  app-switcher, then reopen. (You can also force it with
  `Updates.fetchUpdateAsync()` + `Updates.reloadAsync()` from
  `expo-updates` in the JS layer.)
- **Don't OTA after a build.** A fresh build's bundle is the latest;
  publishing an OTA right after just creates a duplicate.
- **`appVersionSource: "remote"`** in `eas.json` means EAS server
  manages the build number (autoIncrement). The marketing version
  (`expo.version` in `app.json`) is what you bump for runtime version.
- **The catch-all `/api/d/[...key]` redirector lives on the web side**
  and ships independently via Amplify Hosting. Mobile changes that
  rely on a new server URL only work after the Amplify deploy lands.
