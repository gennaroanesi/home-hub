# Home Automation Integration — Design Doc

Status: **Planning / blocked on infrastructure setup**
Last updated: 2026-04-09

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

### Infrastructure setup

- [ ] **Enable Hyper-V on Windows 11 Home.** Home doesn't ship with it — there's a well-known installer script (search "enable Hyper-V on Windows 11 Home script"). After running it, reboot and verify with `bcdedit /enum | findstr hypervisorlaunchtype` — should show `Auto`.
- [ ] **Download the HA OS Hyper-V image** from [Home Assistant's install docs](https://www.home-assistant.io/installation/windows/) (`.vhdx` file). Don't use VirtualBox — it conflicts with WSL2.
- [ ] **Create the Hyper-V VM**: 4 GB RAM, 2 vCPUs, attach the `.vhdx`, use a **External virtual switch** (not Default Switch — HA needs a stable IP on your LAN). Start the VM.
- [ ] **Open HA in a browser** at `http://homeassistant.local:8123` and complete the onboarding (create a user, set the home location).
- [ ] **Install the Unifi integration** in HA first (Settings → Devices & services → Add integration → "Unifi Network"). This gives us `device_tracker` entities for future home-wifi detection. Point it at your Unifi controller.
- [ ] **Install integrations for each device**, in priority order: Resideo (thermostat) → Eufy (locks) → Samsung SmartThings (TV/appliances) → MyQ (garage) → iRobot Roomba. Some of these require cloud account linking (Resideo, SmartThings); Eufy and MyQ use community add-ons that may need HACS. Roomba is built-in and local — should auto-discover on the LAN.

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
