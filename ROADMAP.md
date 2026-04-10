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

## Top 3 picks

If picking three to build next, highest leverage given the current stack:

1. **Shopping list + pantry** — biggest daily ROI on the WhatsApp bot.
2. **Documents vault** — agent becomes dramatically more useful when it can answer questions about insurance, warranties, etc.
3. **Home maintenance log** — reuses recurring-tasks infra almost directly.
