# Home Hub Roadmap

Ideas for future features. Not committed — just a parking lot for things that would pair well with the existing agent + WhatsApp bot.

## Shipped
- Main agent
- Tasks (with recurring)
- Bills
- Calendar

## Candidates

### Household operations
- **Shopping list / pantry** — shared list, agent adds items from WhatsApp ("we're out of olive oil"), tracks pantry staples + expiries.
- **Meal planning** — weekly menu that auto-generates the shopping list; agent suggests meals from what's in the pantry.
- **Home maintenance log** — HVAC filter changes, appliance service, warranty + manual storage. Reuses the recurring-task engine almost directly.
- **Service providers** — plumber, electrician, cleaner, doctors with notes and last-contact date.

### Life admin
- **Documents vault** — lease, insurance, passports, warranties; agent answers questions like "when does my passport expire?" via RAG over stored docs.
- **Subscriptions tracker** — renewal dates, price hikes. Distinct from bills: focus is on the cancel/keep decision.
- **Vehicle log** — registration, insurance, service history, mileage — feeds recurring tasks.
- **Medications / health** — refill reminders, appointment log.

### Couple-specific
- **Shared finances** — beyond bills: savings goals, reimbursements between us, monthly summary.
- **Gift ideas / wishlist** — running list for each other + family, tagged by occasion.
- **Travel planner** — trip itineraries, packing lists, shared on calendar.
- **Decisions log / shared notes** — things we've agreed on (paint colors, restaurants to try, "next time we'll…").

### Calendar integrations
- **External calendar sync (iCal)** — two-way sync with Google/Apple/Outlook calendars via CalDAV or ICS feeds. Options:
  - **Read-only ICS feed export** — publish each person's home-hub events as an `.ics` URL they can subscribe to from their phone calendar (simplest, one-way).
  - **Two-way CalDAV** — import external events alongside home-hub events, write home-hub events back. Needs per-person OAuth for Google, app-specific passwords for Apple, etc.
  - **Pull-only ICS import** — periodically fetch an ICS URL (e.g. work calendar, shared family calendar) and mirror events into the home-hub calendar as read-only overlays.
  - Useful for: pulling in flight confirmations from TripIt, work calendars, school schedules, etc.

### Vehicle integration
- **BMW ConnectedDrive** — both cars are BMWs with MyBMW app access. HA's `bmw_connected_drive` integration (via `bimmer_connected`) would surface location, odometer, fuel/charge, door/lock status, and remote services (lock/unlock, climate pre-conditioning) as entities that flow into `homeDevice` through `hass-sync` for free. **Blocker:** BMW discontinued public API access for this use case — needs a workaround or a future re-enablement before it's feasible. Parked until then.
- Once unblocked, natural integrations: "where's Cristine's car?", "enough gas for the weekend trip?", fuel-level warnings in the daily summary, lock-cars-before-bed automation (gated on HIGH sensitivity in v2 device control).

### Agent capabilities
- **WhatsApp image attachments → agent vision** — today Janet drops any incoming media on the floor. Three layers need changes to make "send a screenshot of a flight confirmation → agent parses it → creates trip legs" work:
  1. **WA bot** ([whatsapp-bot/src/index.ts](whatsapp-bot/src/index.ts)) — detect `imageMessage`, download via Baileys `downloadMediaMessage`, upload to S3 (or base64-encode under the size limit), pass to the agent mutation.
  2. **`invokeHomeAgent` mutation** ([amplify/data/resource.ts](amplify/data/resource.ts)) — add an `images` argument (list of `{ s3Key | base64, mediaType }`).
  3. **Agent handler** ([amplify/functions/agent/handler.ts](amplify/functions/agent/handler.ts)) — build multi-part content blocks `[{type: "image", source: {...}}, {type: "text", text: userMessage}]`. Claude Opus 4.6 has native vision, no extra SDK work.
  - Pairs naturally with the trip/leg CRUD tools: user screenshots a boarding pass → agent creates the trip + legs automatically.

### Weather / aviation briefing
- **Location-based airport selection** — today the daily summary and Janet's `get_weather_briefing` tool hardcode `DEFAULT_ICAO = "KAUS"`. Instead, infer "where will I actually be today" from calendar events and trip destinations, then pick the nearest airport with a published TAF.
  - Needs: a bundled dataset of ~2500 US airports with lat/lon + TAF availability (the FAA publishes this; ~200KB JSON), a nearest-point lookup (haversine, no index needed at this size), and a "whose location wins" rule when Gennaro and Cristine are in different places (household summary picks per-person if they differ).
  - Source signals in priority order: active trip destination → today's calendar event with a `location.latitude/longitude` → home airport fallback.
  - Hook point already exists: `getMorningWeatherBriefing(icao, ctx)` in `lib/aviation-weather.ts` takes the ICAO as a param, so swapping in a dynamic selector is a one-line change at the call site once the lookup function exists.
- **Decoded TAF period summaries** — right now Haiku interprets raw TAF text on the fly ("TEMPO 1518 -SHRA BKN020" → "brief showers 3-6pm"). A deterministic parser would be testable and faster. Not urgent — Haiku does fine — but worth noting as a quality improvement for flying-day briefings.
- **Weather fetch caching** — daily-summary runs once a day so it's fine, but Janet's agent tool hits aviationweather.gov on every call. Module-level memoization with a ~10 min TTL would cut latency for rapid follow-up questions. Only worth it if we see actual latency or rate-limit issues.

### Fitness / gym tracker
- **Gym check-in tracker** — the core feature. Optimized for the WhatsApp flow: message Janet "gym" or "worked out" and she logs it. No forms, no reps/sets, no friction. Tracks per-person streaks (consecutive days with rest-day awareness) and weekly goal progress (e.g. "3/4 this week").
  - Data model: `homeGymCheckin` (personId, checkedInAt, activityDate, notes, source) + `homeGymGoal` (personId, weeklyTarget, restDays).
  - Agent tools: `gym_checkin(person?, notes?)`, `gym_status(person?)`, `gym_set_goal(person, weeklyTarget, restDays?)`.
  - Daily summary line: "Gennaro: 12-day streak, 3/4 this week | Cristine: 8-day streak, 2/3 this week — 1 more to hit goal". Mid-week nudge if behind pace.
  - `/fitness` page: streak counter, weekly progress bar, GitHub-style contribution calendar (~3 months), check-in button, recent history list, goal settings. Simple single page, everything above the fold.
- **Workout notes (tier 2)** — optional free-text notes on check-ins ("upper body", "legs + cardio"). Janet can answer "when was my last leg day?" or "how many cardio sessions this month?". Only build if tier 1 sticks after 2 weeks of use.
- **Weight tracking (tier 2)** — log via Janet ("175 lbs today") or the web UI. Weekly/monthly trend line on `/fitness`. Opt-in per person. Only build if requested.
- **Apple Health / Google Fit sync (tier 3)** — auto-detect gym visits from phone activity data. Technically hard (iOS-only API, Google deprecating Fit, needs mobile app or Shortcuts). Not worth building — the WhatsApp check-in is already 3 seconds.

## Top 3 picks

If picking three to build next, highest leverage given the current stack:

1. **Shopping list + pantry** — biggest daily ROI on the WhatsApp bot.
2. **Documents vault** — agent becomes dramatically more useful when it can answer questions about insurance, warranties, etc.
3. **Home maintenance log** — reuses recurring-tasks infra almost directly.
