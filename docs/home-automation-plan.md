# Home Automation Integration — Design Doc

Status: **v1 read-only deployed; hardware expansion phase**
Last updated: 2026-04-11

Plan for integrating physical devices (thermostat, locks, cameras, appliances, networking) into Home Hub — both the web frontend and the agent. Scoped to v1 (read-only) with a clear path to v2 (control).

## Devices in scope

| Device | Vendor | Access |
|---|---|---|
| Thermostat | Resideo (Honeywell Home) | Via Home Assistant |
| TV, fridge, washer, dryer | Samsung | Via Home Assistant (SmartThings) |
| Home network + cameras | Unifi | Via Home Assistant (local) |
| Door locks | Eufy | Via Home Assistant (community) |
| Garage door | MyQ | Via Home Assistant (when it works) |
| Vacuum | iRobot Roomba | Via Home Assistant (local LAN, unofficial protocol) |

**Why Home Assistant instead of direct integrations:** four of the six devices (Unifi, Eufy, MyQ, most Samsung) have no stable cloud API or are LAN-only. HA has maintained integrations for all of them and absorbs every vendor-specific quirk. We build one HA integration, we get all six devices.

## Radio stack

HA sits behind two USB radios plugged into the Hyper-V VM's host PC (passed through to the VM):

| Radio | Purpose | Status |
|---|---|---|
| **Zooz ZST39 LR** | Z-Wave (classic + Long Range 800-series) | ✅ In hand |
| **HA Connect ZBT-2** | Zigbee + Thread / Matter | 🛒 To purchase |

**Why two radios:** each protocol has strengths and the ecosystems don't overlap much. Z-Wave dominates for battery-efficient switches/locks/sensors from US vendors (Zooz, Aeotec, Inovelli); Zigbee/Matter dominates for bulbs and cheap environmental sensors (Hue, Ikea, Aqara). Running both is the canonical HA setup. HA treats both as native integrations (Z-Wave JS + ZHA + Matter controller) with a unified entity model.

**Why ZST39 LR specifically:** Z-Wave Long Range gives ~4x range over classic Z-Wave (up to ~80 ft reliable through walls vs ~30 ft), star topology that skips mesh routing, and ~10 year battery life on LR-capable sensors. Classic 700/800 devices still work on the same stick — LR is backward compatible. The "LR" designation matters per-device, not per-network; we buy LR-variant Zooz devices where they exist, classic where they don't.

**Why Connect ZBT-2 specifically:** newest generation replacement for SkyConnect. Supports Zigbee and Thread simultaneously, Matter commissioning via HA natively, same ~$40 price point, official HA product so no driver weirdness.

**Installation gotcha:** the two radios must be physically separated by ~1 ft (use a short USB extension cable for one). Both use 2.4GHz-adjacent frequencies and interfere when adjacent. HA docs explicitly call this out.

## Device enrollment plan

Purchase order, lowest-commitment first. Each step is independent — stop at any point if it's doing what you need.

### Phase 1 — validate the stack (Z-Wave only)

Goal: prove the ZST39 pairs correctly, devices sync into the `homeDevice` cache, and the `/devices` page renders their state. Two cheap plug-in devices, no wiring.

- **2× Zooz ZEN04 800LR Smart Plug** (~$25 each) — nightstand lamp power. Pair in HA via Z-Wave JS, verify they appear as `switch.*` entities, pin to dashboard manually.
  - Inclusion gotcha: device must be within ~10 ft of the stick during pairing. Either carry the laptop to the bedroom or temporarily place the ZST39 on a USB extension cable during first-pair.
  - LR vs classic: during inclusion, Z-Wave JS will ask whether to pair as LR or classic. Choose LR — the ZEN04 supports it and we want the range/battery benefits.

### Phase 2 — overhead lighting (Z-Wave in-wall)

Goal: replace one room's wall switch with a smart paddle. Proves neutral-wire installation works and builds confidence for whole-house rollout.

- **Neutral-wire precheck** (before purchase): kill power at breaker, pull a switch out of its box, verify a bundle of capped white wires at the back of the gang box. Austin homes ~30 years or newer almost always have neutral. No neutral → narrower options (Zooz ZEN77 no-neutral dimmer, with LED compatibility caveats).
- **1× Zooz ZEN72 800LR Dimmer** (~$35) or **ZEN71 on/off switch** — replaces the paddle but keeps the existing wall plate / gang box. Requires neutral.
- Start with one room. If it pairs cleanly and the paddle feels right, scale to the rest of the house.

### Phase 3 — add Zigbee/Matter radio

Goal: second radio network alive in HA, one bulb working.

- **1× Home Assistant Connect ZBT-2** (~$40) — Zigbee + Thread/Matter radio. Plug into PC, HA auto-detects, ZHA integration installs.
- **2× Philips Hue White & Color Ambiance E26** (~$50 each) — nightstand color lamps. Pair to ZHA directly (no Hue bridge needed). Enter HA as `light.*` entities, **auto-pin** on next sync (since `light` is in `AUTO_PIN_DOMAINS` as of ef20d71).
- Critical: smart bulbs go in **plug-in lamps only**. Never in a ceiling fixture controlled by a wall switch — if anyone flips the physical switch off, the bulb loses power and disappears from HA until someone flips it back on. For overhead lights, use phase 2 smart switches instead.

### Phase 4 — sensors (Zigbee, optional)

Ambient data for automations and morning-summary enrichment. All Zigbee, all battery-powered, ~1-2 year coin cell life.

- **Aqara temperature/humidity sensors** (~$15 each) — one per interesting room (bedroom, garage, maybe the closet that has the HVAC intake). Used by the daily summary for "bedroom got to 78°F overnight" context, and for HVAC automations in v2.
- **Aqara motion sensors** (~$20 each) — pair with phase-2 switches for "turn on bathroom light between 11pm and 6am if motion detected". HA-native automation, no Home Hub involvement needed.
- **Aqara door/window contact sensors** (~$15 each) — tied into HVAC automations ("don't run AC if the back door is open") and daily summary ("⚠️ garage side door has been open for 3 hours").
- All pair to ZHA, no Aqara bridge required (HA bypasses the Aqara hub).

### Phase 5 — whole-house rollout

If phases 1-3 all work, scale up:
- More Zooz dimmers (ZEN72 / ZEN71) for every interior wall switch
- Outdoor lighting (porch, backyard) via waterproof Zooz relays
- Kitchen / bath under-cabinet LED strips via Zigbee controllers
- Whatever specific automations prove valuable from phase 4 sensor data

**Stop criteria for whole-house:** if the first two rooms in phase 2 are flaky (switches missing events, mesh routing issues, inclusion problems) I'd pause and debug before spreading the problem across 15 more switches. Z-Wave LR's star topology makes this less likely than classic Z-Wave, but worth a checkpoint.

## Policy implications for v2 device control

Once we start shipping device control (v2), the new device classes map to the risk matrix in `lib/devicePolicy.ts`:

| Device class | Sensitivity | Rationale |
|---|---|---|
| Smart plugs (Zooz ZEN04) | LOW | Turning off a lamp is always safe |
| In-wall switches (Zooz ZEN71/72) | LOW | Same |
| Smart bulbs (Hue) | LOW | Same — includes color changes |
| Temp/humidity sensors | READ_ONLY | No actionable state |
| Motion sensors | READ_ONLY | Same |
| Contact sensors | READ_ONLY | Same |
| Door locks (Eufy) | HIGH | Existing rule, never over WA |
| Garage door (MyQ) | HIGH | Existing rule |
| Thermostat (Resideo) | LOW if ±3°F swing, MEDIUM if larger | Existing rule |

**No schema changes needed** for any of the new device classes — all slot into the existing tiers. The `/devices` page admin UI (not built yet) will let us set `sensitivity` per device during enrollment.

## Architecture

```
┌──────────────────┐   HTTPS   ┌─────────────────┐   HTTPS   ┌────────────┐
│  Home Hub (AWS)  │ ────────→ │   Nabu Casa     │ ────────→ │  HA on PC  │
│  Lambdas + UI    │ ←──────── │   (remote URL)  │ ←──────── │  (Hyper-V) │
└──────────────────┘  +token   └─────────────────┘           └────────────┘
```

- **Home Assistant OS** runs in a VM on Gennaro's Lenovo IdeaCentre Mini (Windows 11 Home, always on)
- **Nabu Casa** ($6.50/mo) provides a stable `https://*.ui.nabu.casa` URL — no DNS migration (domain stays on Route 53), no port forwarding, no Cloudflare account
- **Lambdas** talk to HA via its REST API using a long-lived access token, stored as an Amplify secret
- **Outbound queue** (existing `homeOutboundMessage`) is reused for HA health alerts via the WA bot

### Why Nabu Casa and not Cloudflare Tunnel

`cristinegennaro.com` is on Route 53. Cloudflare Tunnel would require migrating DNS to Cloudflare, which is doable but not worth it for one integration. Nabu Casa is $6.50/mo, takes 5 minutes to set up from inside HA, and funds HA development. Tailscale Funnel was the free alternative but would give us a `.ts.net` URL which is uglier and has bandwidth caps.

### Why Hyper-V and not VirtualBox

Gennaro actively uses WSL2. VirtualBox runs in a degraded mode when Windows has Hyper-V/WSL2 enabled, and disabling WSL2 isn't an option. Windows 11 Home doesn't include Hyper-V by default but there's a well-known installer script. HA OS has an official Hyper-V image.

## v1 — read-only scope

Everything below is **view-only**. No device control ships in v1. The foundation for v2 (control + re-auth + audit log) is built but unused.

### Data model additions

Added to `amplify/data/resource.ts`:

- **`homePerson.homeDeviceTrackerEntity`** (string, optional) — e.g. `device_tracker.gennaro_iphone`. Null = can't determine home-wifi presence for this person. Used by v2 for the risk matrix.
- **`homeDevice`** (new model):
  - `entityId` (string, required) — HA entity id like `climate.living_room`
  - `friendlyName` (string)
  - `domain` (string) — `climate`, `lock`, `cover`, `camera`, `switch`, `sensor`, etc.
  - `area` (string, nullable) — e.g. "Living Room"
  - `sensitivity` enum `READ_ONLY | LOW | MEDIUM | HIGH` — set manually per device during enrollment. Drives the v2 risk matrix.
  - `isPinned` (bool) — show on `/devices` dashboard
  - `lastState` (json) — cached state blob from HA
  - `lastSyncedAt` (datetime)
- **`homeDeviceAction`** (new model, defined but not yet written to in v1): audit log scaffold. `personId`, `entityId`, `action`, `params`, `origin` enum `UI | AGENT`, `senderHomeWifi` bool, `elevatedSession` bool, `result` enum `SUCCESS | FAILED | DENIED`, `error`, `createdAt`.
- **`homeHassStatus`** (singleton row) — current HA availability, last-flip time. Used by the healthcheck lambda to avoid spamming outbound messages.

### Central policy module

New file `lib/devicePolicy.ts` — single source of truth for the risk matrix. Exports:

```ts
type Context = { origin: "UI" | "AGENT"; senderHomeWifi: boolean; elevatedSession: boolean };
type Decision = { allowed: boolean; reason?: string; requires?: "password_reauth" | "reply_confirm" };

function canPerform(sensitivity: Sensitivity, action: "read" | "control", ctx: Context): Decision;
```

Imported by the agent handler and the `/devices` frontend. Changing policy = one-file diff + code review + git history. If we later find we're editing it often, that's the signal to graduate to a DB-driven admin UI.

v1 only consults `canPerform(sensitivity, "read", ...)`. The control rules exist in the module but nothing calls them yet.

### Risk × auth matrix (v2 preview — encoded in `devicePolicy.ts` now, unused in v1)

| Category | Examples | UI | Agent (remote) | Agent (home wifi) |
|---|---|---|---|---|
| **Read state** | Temperature, lock state, camera snapshot | Allow | Allow | Allow |
| **Low-risk comfort** | Thermostat ±3°F, lights, TV on/off | Allow | Reply confirm | Allow |
| **Medium-risk comfort** | Thermostat >3°F, stop appliance, HVAC off | UI confirm modal | **Refuse** | Reply confirm |
| **Low-risk physical** | Lock door, **close** garage (safer) | Allow | Reply confirm | Allow |
| **High-risk physical** | **Unlock door, open garage** | Password re-auth (5-min grace) | **Refuse always** | **Refuse always** |
| **Surveillance** | Camera snapshot / live stream | Allow | Snapshot only | Allow |

Decisions baked into this:
- **WhatsApp can never unlock doors or open the garage**, even from home wifi. Convenience does not outweigh blast radius of a compromised WA account or spoofed wifi presence. Use the UI (with password re-auth) or physical keys.
- **Locking and closing are always less restricted than unlocking and opening** — making the house safer is low-risk.
- **Reply confirmation** = "reply 'yes' within 60 seconds" via the same WA channel. Human-scale second factor.
- **Password re-auth** has a 5-min grace window on the client so a sequence of sensitive actions doesn't require re-entering every time.
- **Home wifi detection** uses HA's `device_tracker` entity (populated by Unifi integration). Agent looks up `homePerson.homeDeviceTrackerEntity`, queries HA, gets `home` or `not_home`. Caveats: MAC randomization means re-enrolling on phone change; `consider_home: 600` to reduce flapping.
- **Fail closed**: if HA is down or the device tracker is unavailable, treat the user as *remote*. A genuinely-at-home user whose HA just crashed gets a slightly more annoying UX for a few minutes. Acceptable.

### v1 components to build

| Component | Location | Purpose |
|---|---|---|
| HA proxy lambda | `amplify/functions/hass-proxy/` | `getStates()`, `getState(entityId)`, `healthcheck()`. Env: `HASS_BASE_URL`, `HASS_TOKEN`. Exposed as an AppSync custom query (same pattern as `invokeHomeAgent`). |
| HA sync lambda | `amplify/functions/hass-sync/` | Daily EventBridge. Calls `getStates()`, upserts `homeDevice` rows. First run discovers entities; enrollment (setting `sensitivity` and `isPinned`) is manual afterward. |
| HA healthcheck lambda | `amplify/functions/hass-healthcheck/` | Every 15 min. Pings HA. Updates `homeHassStatus`. On flip that's stable for 30+ min, writes a `homeOutboundMessage` with `kind=ha_down` / `kind=ha_up`. |
| Agent tool | `amplify/functions/agent/handler.ts` | `get_home_devices(domain?, area?)` — reads from the `homeDevice` cache + last state. Read-only. No control tool in v1. |
| `/devices` page | `pages/devices.tsx` | Grouped by area, one tile per pinned device. Climate → current temp + mode. Lock → state. Camera → latest snapshot. "Refresh" button calls the sync lambda. No control buttons. |
| Daily summary enrichment | `amplify/functions/daily-summary/handler.ts` | Fetch pinned device states before composing. Add a "Home status" line like "🏠 Inside 68°F · All doors locked". On healthcheck fail → "⚠️ Home devices unreachable". |

### Secrets

Two new Amplify secrets, set via `npx ampx sandbox secret set`:
- `HASS_BASE_URL` — the Nabu Casa remote URL
- `HASS_TOKEN` — a long-lived access token generated from HA's user profile page

## v2 — device control (not yet scheduled)

Builds on top of v1 without changing the data model. Adds:
- `control_device` agent tool with the risk-matrix policy enforced
- Control buttons on `/devices` page
- Password re-auth flow + `elevatedUntil` session marker
- Reply-confirmation flow in the WA bot for agent-originated comfort controls
- `homeDeviceAction` starts receiving writes on every attempt (success, failed, or denied)
- Home-wifi detection via `device_tracker`

---

## Open items / TODO for Gennaro

These unblock me from starting the code. Ordered by what I need first.

### Infrastructure setup — done

- [x] **Hyper-V enabled on Windows 11 Home** and HA OS VM running 24/7 on the Lenovo IdeaCentre Mini.
- [x] **Nabu Casa account + Remote UI enabled** — gives us the stable `*.ui.nabu.casa` URL.
- [x] **Long-lived access token** generated and stored as Amplify secrets (`HASS_BASE_URL`, `HASS_TOKEN`) for both the `hass-sync` and `daily-summary` lambdas.
- [x] **Unifi integration installed** — provides `device_tracker` entities (used later for v2 home-wifi detection) and lots of network state we ignore by default.
- [x] **Other integrations installed** at least partially — Samsung SmartThings for appliances. Resideo / Eufy / MyQ pending availability. Roomba pending purchase.

### Hardware purchasing checklist — in progress

Ordered by the phases in the "Device enrollment plan" section above.

**Phase 1 — validate the Z-Wave stack**
- [ ] 2× **Zooz ZEN04 800LR Smart Plug** (~$50 total). Nightstand lamps. Purchase from Zooz direct or Amazon.

**Phase 2 — overhead lighting**
- [ ] Neutral-wire check on one switch (breaker off, pull the switch, look for white wire bundle at back of box).
- [ ] 1× **Zooz ZEN72 800LR Dimmer** (~$35) if dimming is wanted, OR **ZEN71 on/off switch** (~$30). Start with one room.

**Phase 3 — Zigbee / Matter radio**
- [ ] 1× **Home Assistant Connect ZBT-2** (~$40). Official HA product, ZBT-2 replaces the original SkyConnect. Buy direct from the HA store or authorized reseller.
- [ ] **Short USB extension cable** (~$5) to physically separate the ZBT-2 from the ZST39 LR stick — they interfere when adjacent.
- [ ] 2× **Philips Hue White and Color Ambiance E26** (~$50 each) for color-changing nightstand lamps. Pair directly to ZHA, no Hue bridge needed.

**Phase 4 — sensors (optional, any time)**
- [ ] Aqara temperature/humidity sensors for the bedroom and any other rooms of interest (~$15 each)
- [ ] Aqara motion sensors for hallway/bathroom auto-on automations (~$20 each)
- [ ] Aqara door/window contact sensors if you want HVAC automations or door-left-open alerts (~$15 each)

#### Setup gotchas to watch out for

**Why Hyper-V and not VirtualBox (recap)**
- VirtualBox and Hyper-V both want exclusive control of the CPU's hardware virtualization extensions (VT-x / AMD-V).
- WSL2 runs Linux in a lightweight Hyper-V VM under the hood — so using WSL2 already enables the Hyper-V platform on the host.
- VirtualBox on a Hyper-V-enabled system falls back to a slower emulation mode: ~2–10x slower, flaky nested virt, long-running VMs can hang or crash. Not safe for a 24/7 HA install.
- Hyper-V runs HA and WSL2 cleanly side-by-side because they share the same underlying hypervisor.

**Enabling Hyper-V on Windows 11 Home**
- The installer is a `.bat` script that runs `dism` to add the Hyper-V packages Home normally excludes. Find it on GitHub — **sanity-check the commands before running**. It should just be `dism /online /enable-feature /featurename:Microsoft-Hyper-V-All` and related feature names.
- **Reboot is required** after the script finishes. Hyper-V doesn't activate until then.
- After reboot, verify from an **admin** PowerShell:
  ```powershell
  Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V
  ```
  Should show `State : Enabled`. "Hyper-V Manager" should also appear in the Start menu.

**Creating the VM (the gotcha-heavy step)**
- Use the **`.vhdx`** image from HA's install page. The `.vdi` variant is VirtualBox-only, don't grab that one by mistake.
- In Hyper-V Manager: New → Virtual Machine → **Generation 2**. HA OS supports UEFI and needs Gen 2 for proper boot.
- **Disable Secure Boot on the VM** (Settings → Security → uncheck "Enable Secure Boot"). HA OS won't boot with it on — symptom is a black screen after power-on.
- **Virtual switch**: create a new **External** switch bound to your physical network adapter. The "Default Switch" uses NAT, which means:
  - HA gets a different IP every reboot
  - HA can't see devices on your LAN
  - Unifi integration can't observe phones for device tracking
  — This defeats the whole purpose. Always External.
- **Fixed memory, not Dynamic.** Give it a fixed 4 GB. HA's supervisor doesn't play well with ballooning.
- Attach the `.vhdx` as the boot drive (don't create a new one).

**First boot**
- HA takes ~5 minutes on first boot while it pulls supervisor/core containers. Watch the console in Hyper-V Manager — you'll see it print an IP address when it's ready.
- Hit `http://<ip>:8123` in your browser. **Don't use `http://homeassistant.local:8123`** — mDNS from a Windows host to its own Hyper-V guest is flaky; use the raw IP.
- If you want a stable name, set a DHCP reservation for the VM's MAC on your router so the IP never changes.

**Common first-boot failures**
| Symptom | Cause | Fix |
|---|---|---|
| Black screen after power-on | Secure Boot enabled | VM Settings → Security → uncheck "Enable Secure Boot" |
| "VT-x not available" | Virtualization disabled in BIOS | Reboot into BIOS, enable Intel VT-x or AMD-V |
| HA boots but no IP in console | VM on Default Switch (NAT) | Change to External switch and restart VM |
| HA loads but can't discover Unifi | Same — wrong switch | Same fix |
| Dashboard loads on `http://ip:8123` but not `homeassistant.local:8123` | mDNS flakiness host→guest | Use the IP directly, set a DHCP reservation |

If you hit anything not on this list, paste the error or symptom in the Home Hub chat and we'll troubleshoot from there.

### Nabu Casa

- [ ] **Sign up for Nabu Casa from within HA**: Settings → Home Assistant Cloud → Sign up. $6.50/mo, 30-day trial.
- [ ] **Enable Remote UI.** Note the generated URL — it'll look like `https://<random>.ui.nabu.casa`.
- [ ] **Test the URL from outside your network** (e.g. phone on cellular) before giving it to me — if it loads HA, we're good.

### Access token

- [ ] **Generate a long-lived access token**: in HA, click your user profile (bottom-left) → "Long-Lived Access Tokens" section at the bottom → "Create Token". Name it `home-hub-lambda`. Copy the token immediately — HA will never show it again.
- [ ] **Store the token and URL somewhere safe temporarily** (password manager). I'll give you the exact `npx ampx sandbox secret set` commands to put them into Amplify when I'm ready to write code.

### Device enrollment decisions (can wait until after v1 code is written)

- [ ] For each HA entity you want on the dashboard, decide on:
  - **Sensitivity tier**: `READ_ONLY` | `LOW` | `MEDIUM` | `HIGH` (see matrix above)
  - **Pinned**: yes/no (shows on `/devices` dashboard)
- [ ] For each person in `homePerson`, set `homeDeviceTrackerEntity` to the Unifi-generated entity for their phone (e.g. `device_tracker.gennaro_iphone`). This can be done from the admin UI once I add the field.

### When I can start coding

I can start the **data model + policy module + HA proxy lambda** as soon as:
1. You confirm Hyper-V is installed (I don't need HA to be fully working — I just need to know the stack is viable)
2. You have a rough timeline on Nabu Casa signup (so I know whether to stub the secrets or wait)

I **cannot** finish v1 without:
1. A real Nabu Casa URL
2. A real HA token
3. HA actually running and responding to `/api/` pings

Ping me when (1) and (2) are done and I'll start on the parts that don't need a live HA instance. Everything from the sync lambda onward needs a real HA to test against.
