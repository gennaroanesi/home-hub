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

## Top 3 picks

If picking three to build next, highest leverage given the current stack:

1. **Shopping list + pantry** — biggest daily ROI on the WhatsApp bot.
2. **Documents vault** — agent becomes dramatically more useful when it can answer questions about insurance, warranties, etc.
3. **Home maintenance log** — reuses recurring-tasks infra almost directly.
