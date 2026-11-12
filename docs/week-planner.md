# Week planner

Status: built 2026-11-09. Step 1 of 2: the review screen and a Sunday nudge.
Step 2 is an AI-written summary of the week (see Next).

## What it is

A 10–15 minute Sunday review of the coming week, so the family calendar is
actually complete: who's in the office which day, whether anyone is
double-booked, who each family-calendar event is for, and where Dolce is
(daycare is booked by hand, there's no rule for when she needs it).

- **Web:** `/week` (sidebar: right under Janet). Notes + "Mark reviewed"
  first, then what needs attention, then a grid of people, pets and
  household × Monday–Sunday (each person's appointments on one row, their
  office/home status on the row below, with a "home?" hint when a weekday
  has an appointment in working hours); a card per day on phones; then the
  sections. `?week=YYYY-MM-DD` picks the week.
- **Quick actions:** + event (header, or "+ event" in any person / household
  day, prefilled with that day and person; uses `EventModal`), edit an
  event, + task and tick tasks done (`TaskModal`, `toggleTaskCompleted`),
  add to a shopping list. These write the models directly like the Tasks /
  Calendar pages do; Janet has her own create_task / create_event tools.
- **Mobile:** More → Week planner. Notes + reviewed first, + Event / + Task
  (the app's `EventFormModal` / `TaskFormModal`), tap a day to set a
  status, an event to say who it's for, the pet's day to mark daycare.
- **Mock data:** `npm run seed:week-dev` (sandbox only; `--reset`,
  `--remove`) seeds this week and next with the cases above.
- **Janet / API / `hh`:** the same ops ("who's in the office Thursday?",
  "Dolce has daycare Wednesday", "the dentist on Friday is Cris's").
- **Sunday 17:00 Chicago:** WhatsApp to the household group with the
  week's headline and what needs attention, linking to `/week`. Skipped
  when the week is already marked reviewed.

The default week is this week Monday–Thursday and next week from Friday on,
so a Sunday review lands on the coming week.

## Data

| Model | What |
|---|---|
| `homeCalendarDay` (existing) | One row per person per day: office / home / PTO / travel / vacation / choice day / holiday. Existed before but had no rows; trips imply travel for their participants when nothing is set. |
| `homeCalendarEvent` (existing) | Events, native and from the Apple family calendar feed. The planner can set `assignedPersonIds` on feed events; ics-sync never writes that field, so the assignment survives syncs (it's lost only if the event's UID changes). |
| `homeCalendarFeed` (existing) | Per-feed settings (`lib/calendar-feeds.ts`): `ownerMode` ASK (default: the planner asks "who is it for?") / HOUSEHOLD / PEOPLE + `ownerPersonIds`, and `uses` (CALENDAR, WEEK, SUMMARY, AGENT; empty = all). Every event reader goes through `eventsFor(events, feeds, use)`, which drops feeds not used there and fills an unassigned event's people from its feed (`feedOwned`, so nothing asks). Set on Calendar feeds. |
| `homePetDay` (new) | Where a pet is on a day: daycare / boarding / sitter / with us. |
| `homeWeekReview` (new, key `weekStart`) | Reviewed at / by, notes, and `summary` for the AI summary later. |

## Sections

Under the grid (and as cards on mobile), from `lib/week-sections.ts`:

| Section | What | Source |
|---|---|---|
| Money | Paydays (projected), scheduled transactions due, what posted (internal transfers left out) | `homePaycheck`, `homeFinanceRecurring`, `homeFinanceTransaction` |
| To do | Open tasks due this week or overdue (one-off and recurring occurrences), reminders firing | `homeTask`, `homeTaskOccurrence`, `homeReminder` |
| Travel | Trips overlapping the week, legs and reservations, trip checklist progress | `homeTrip`, `homeTripLeg`, `homeTripReservation`, `homeChecklist` |
| Care | Medical visits, pregnancy care due / booked / opening (and weeks on Monday), pet vaccines due and meds ending or out of refills | `homeMedicalVisit`, `homePregnancy`, `homeCareItem`, `homePetVaccine`, `homePetMedication` |
| Birthdays | `homePerson.birthday` (new; set on Household → edit; year 1900 = unknown, no age shown) | `homePerson` |
| Errands | Open shopping items per list, unfinished checklists for this week's trips / events | `homeShoppingList/Item`, `homeChecklist/Item` |

**Paydays** are projected, not read from a calendar: per person, the
regular stubs (bonus / RSU-only ones left out) set the cadence from the
median gap (weekly, biweekly, monthly; 15th + month end is detected from the
dates), and the usual take-home is the median of the last four. History more
than 60 days old isn't projected. Paydays, birthdays and trip starts also
show as markers on each day.

A section that fails to load is listed in `errors` and the rest still
shows.

## Needs attention

Computed in `lib/week-plan.ts` (`buildWeekPlan`):

- **Double-booked:** two timed events assigned to the same person overlap.
- **Who's it for?:** a family-calendar event with no one assigned. Native
  events with no one assigned are household events on purpose and aren't
  flagged; neither are events whose title names a pet ("Dolce Barkin
  Creek"), which show in the pet's row.
- **Not set:** a weekday with no status for someone (and no trip).
- **Overdue:** open tasks past due. A recurring task counts by its open
  occurrence, and not at all once the task is marked completed (same as the
  home page). Editing a recurring task's date moves its open occurrence
  (`taskOccurrenceAction` RESCHEDULE, from web, mobile and Janet's
  `update_task`); before that fix the two drifted, which is why the planner
  once showed more overdue tasks than the home page.
- **Care:** a pet vaccine past due; a required (not optional) pregnancy
  care item due or overdue and not booked.
- **Trip prep:** a trip starting this week with an unfinished checklist.

## Pieces

| Where | What |
|---|---|
| `lib/week-sections.ts` | Pure: the sections and their attention items, payday projection |
| `lib/week-plan.ts` | Pure: week dates, event expansion (recurring via rrule, local time in the household timezone), the plan, the attention list, the nudge text |
| `lib/ops/week.ts` | `get_week_plan`, `set_day_status`, `assign_event_people`, `set_pet_day`, `mark_week_reviewed`; `loadWeekPlan` shared with the Lambda |
| `pages/week.tsx`, `components/week/week-sections.tsx` | Web page and its section cards |
| `mobile/app/(tabs)/more/week.tsx`, `mobile/lib/ops.ts` | Mobile screen; `callOp` over raw GraphQL (the bundled outputs predate `runOp`) |
| `amplify/functions/week-review/` | Sunday nudge. Invoke with `{"dryRun": true}` to log the message without sending |

Janet also has the older `set_calendar_day` / `list_calendar_days` tools for
the same rows; the ops are the ones to extend.

## Shipping the mobile screen

JS only, so an OTA update after the backend is deployed:
`cd mobile && npx eas-cli update --branch production --message "Week planner"`
(see `mobile/APP_UPDATE.md`).

## Next

- **AI summary (step 2):** after the review (or in the Sunday message),
  Claude writes a short "your week" from `get_week_plan` into
  `homeWeekReview.summary`, e.g. "Busy Tuesday: Cris has OB at 9 and PT
  at 9:30; Gennaro is in the office Tue–Thu, so Dolce needs daycare
  Wednesday unless Cris works from home."
- Copy last week's statuses, if setting them from scratch gets tedious.
- An "is anyone home with Dolce?" hint, if a rule turns out to be wanted.
