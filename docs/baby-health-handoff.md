# Baby / health tracking — handoff

Status as of 2026-09-24. Everything below is on `main`. Amplify build 161 (`074871d`) deployed all of it except the **real dates on timeline items**, which are committed but not pushed or deployed yet. `main` is also carrying unpushed doc updates and `3aee9cb` (the regenerated `mobile/amplify_outputs.json`).

**Keep this doc current.** Update it, and the *Baby / health* section of `ROADMAP.md`, in every commit that touches this work.

## Context
- **Pregnancy:** the prod record has due date **2027-05-20**, entered by hand on `/health` (source "set manually"). That puts it at 6w1d on 2026-09-24. The earlier estimate from LMP 2026-08-20 was 2027-05-27. The due date can now be edited on `/health`, and changing it moves the open timeline items to match.
- **Upcoming:**
  - First OB appointments: **Oct 12 and Oct 14**.
  - Open enrollment: **November**. Delivery falls in the 2027 plan year.
- **User's priorities:**
  1. Appointments, labs and results per `homePerson`.
  2. Nutrition and vitamins.
  3. Finances.
  4. Shopping list.
  5. Inventory for clothes, food, etc.
- **Finances stay in gennaroanesi.com,** where the `finance*` models are admin-only and synced from the bank. Don't copy the money side here. Home-hub holds only the *wishlist* side: estimated and paid prices on inventory items.

## What's built

### Health (`/health`, Janet tools, daily summary)
| Piece | Where |
|---|---|
| Models: `homeHealthProvider` (with `phones: HealthProviderPhone[]`), `homeMedicalVisit`, `homeLabResult`, `homePregnancy`, `homeCareItem` | `amplify/data/resource.ts` |
| Due-date math and the 21-item care-timeline template (ACOG-based; flu/COVID/RSV clamped to season) | `lib/pregnancy.ts`, tests in `lib/pregnancy.test.ts` |
| Shared write helpers used by both the page and Janet: `seedCareTimeline`, `shiftCareTimeline` / `planCareShift` | `lib/pregnancy.ts` |
| Visit ↔ calendar sync and visit helpers: `syncVisitEvent`, `linkVisitToCareItem`, `deleteVisit`, `providerPhones`, plus visit-kind and phone-kind labels | `lib/health.ts` |
| Real dates on timeline items: `homeCareItem.scheduledAt` (datetime, real UTC) for SCHEDULED, `completedAt` for DONE. `scheduleCareItem` moves the linked visit and its event, or creates a PLANNED visit, which puts it on the calendar. `completeCareItem` also marks a planned linked visit COMPLETED. | `lib/health.ts`, `lib/pregnancy.ts` (`careUrgency` → `BOOKED` / `CONFIRM`) |
| Page: edit the pregnancy (due date / LMP / source / OB / hospital / status); edit, add and delete timeline items; visits with a timeline-item link and notes; providers with typed phones, address, notes and archive. Picking Scheduled or Done asks for the actual date; rows then show that date instead of the window. | `pages/health.tsx` |
| Janet: `get_pregnancy_status`, `set_pregnancy`, `list_care_items`, `manage_care_item`, `manage_health_provider` (takes a `phones` array), `log_medical_visit` (creates and syncs the calendar event itself), `list_medical_visits`, `add_visit_question`, `record_lab_results`, `list_lab_results` | `amplify/functions/agent/handler.ts` |
| *Baby* section in the daily summary | `amplify/functions/daily-summary/handler.ts` |
| Notes on visits and providers: `homeNote.parentType` gained `VISIT` and `PROVIDER`, using the existing `NotesSection` component | `components/notes-section.tsx`, `pages/notes.tsx` |

### Inventory and wishlist (`/inventory`, Janet tools)
| Piece | Where |
|---|---|
| Base `homeInventoryItem`: category, status `WISHLIST \| OWNED \| SOLD \| GIVEN_AWAY`, owner (`ownerPersonId`, or `pregnancyId` for the baby on the way; neither means household), quantity, estimated and paid price, gift source | `amplify/data/resource.ts` |
| Detail tables keyed by `itemId`: `homeInventoryClothing` (size/color/type/season) and `homeInventoryConsumable` (unit, low-stock threshold, restock list, expiry) | same |
| Shared rules: low stock, wishlist and spent totals, size ordering | `lib/inventory.ts`, tests in `lib/inventory.test.ts` |
| Page with Owned / Wishlist / Past tabs, filters, totals, ± buttons, "Got it" | `pages/inventory.tsx` |
| Janet: `list_inventory`, `manage_inventory_item`, `adjust_inventory_quantity`. Low consumables go onto the shopping list automatically. | `amplify/functions/agent/handler.ts` |

### App shell (built during this work)
- **Left sidebar:** collapses to icons, becomes a drawer on mobile. Sections are To-do / Events / People / Home / Files / Media, defined in `config/nav.ts`. Implemented in `components/sidebar.tsx`.
- **Home dashboard:** tasks, this week's calendar, a Baby card (week of pregnancy, due timeline items, next visit, wishlist total), travel and shopping. Logic in `lib/dashboard.ts`, page in `pages/index.tsx`.
- **Household membership:** one rule, `lib/household.ts` → `isHouseholdMember()`, which checks that `homePerson.groups` includes `home-users`. Janet's "both" and member list, the calendar stripes, the dashboard, the daily summary and reminder push, and mobile all use it. Never infer membership from `cognitoUsername`.

## Design decisions
- **The due date is the anchor.** Changing it moves open *standard* items (the ones with a template `key`). Hand-added and closed items keep their dates. Only the seasonal vaccines have their UPCOMING ⇄ N/A status recomputed; any other N/A was a human decision.
- **Once booked, a timeline item is judged by its date, not its window.** A SCHEDULED item with `scheduledAt` is `BOOKED` (no "due now" or "overdue") until that date passes, then `CONFIRM` ("did it happen?"). A linked visit and the item share one date: saving either one updates the other.
- **Visits own their calendar event.** Every visit that isn't cancelled has an `eventId`:
  - Saving a visit moves the event's title and start time. The event's duration and description stay as the user left them.
  - Cancelling a visit deletes the event.
  - Deleting a visit deletes the event and the visit's notes.
  - If someone deleted the event from the calendar, the next save recreates it.
  - Janet should never create a second event for an appointment.
- **Lab results are one row per value.** Pending rows are filled in place, matched by `testName`. A linked care item becomes DONE once none of its results are pending.
- **Inventory is modular.** A category gets its own detail table only when it needs extra fields. Owner is a plain id column, like the rest of the schema; formal Amplify relationships on `homePerson` risk TypeScript "type instantiation too deep" errors.
- **The wishlist is private.** It sits behind the normal login, with no public registry page.
- **Shared writes live in `lib/`** as functions that take the data client (`any`), so the page and Janet do the same thing. Don't reimplement them in either place.

## Verified
- The web, `amplify/` and `mobile/` type-checks are clean. `npx vitest run` passes 68/68, including the CDK synth and `next build`. The build now goes to `.next-test`, so running the tests no longer breaks `npm run dev`.
- Prod deploy succeeded. `/health`, `/inventory` and the dashboard load on localhost against prod. The user created the pregnancy and visits through the web page and confirmed the new health editing works.
- **Not yet exercised through Janet on WhatsApp,** apart from what the handler type-checks cover.

## Next steps
Do these first:
1. **WhatsApp smoke test:** an appointment (check the calendar event appears), "ask the OB about…", a lab value, and "add a car seat to the baby wishlist, ~$350".
2. **Backfill calendar events** for visits created before `074871d`. They get one the next time they're saved.
3. **Lab reports as documents:** file lab PDFs/photos as MEDICAL `homeDocument`s (Duo-gated) and set `documentId` on the results. This is needed once the Oct 12 labs come back.
4. **Finances, in gennaroanesi.com:** a "Baby" spend group, a savings goal targeting the due date, and a "with baby" scenario **before November open enrollment**.

Then:

5. **Person-level medications and supplements** (generalize `homePetMedication`), plus curated trimester nutrition notes.
6. **`PREGNANCY` entity type for checklists:** hospital bag, nursery, car seat.
7. **Inventory phase 2:** barcode `pendingScan` flow, photos, and automatic low-stock restock from the web page (it's a manual button there today).
8. **Mobile:** Health and Inventory screens, and switch the Today screen to `lib/dashboard.ts`. Later a kick counter, contraction timer and "go time" button.
9. **By ~32 weeks:** create the baby's `homePerson` at delivery, move `pregnancyId` inventory items to their `ownerPersonId`, and build the newborn log (feeds, diapers, sleep).

Small follow-ups:
- Janet's `_peopleCache` lives as long as the Lambda stays warm, so a newly added person may not be recognized until a cold start. Fix before step 9.

## Leave alone
These untracked files in home-hub aren't part of this work: `1x/`, `app.json`, `eas.json`, `scripts/send-smartthings-test.mjs`.
