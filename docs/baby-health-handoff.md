# Baby / health tracking — handoff

Status as of 2026-09-23. Phase 1 is committed on branch `baby-health` (not merged, not deployed).

## Context
- Pregnancy: LMP 2026-08-20 → due **2027-05-27** (LMP + 280d). 4w6d on 2026-09-23.
- First OB appointments: **Oct 12 (7w4d) and Oct 14 (7w6d)**. Phase 1 needs to be deployed before then.
- User's priorities: (1) appointments, labs, results per `homePerson`; (2) nutrition and vitamins; (3) finances; (4) shopping list (exists); (5) inventory for clothes, food, etc.
- Finances **stay in gennaroanesi.com** (its `finance*` models are admin-only there). Don't port them here.

## What phase 1 added
| Piece | Where |
|---|---|
| Date math + care-timeline template (21 ACOG-based items; flu/COVID/RSV clamped to season) | `lib/pregnancy.ts`, tests in `lib/pregnancy.test.ts` |
| Models: `homeHealthProvider`, `homeMedicalVisit`, `homeLabResult`, `homePregnancy`, `homeCareItem` | `amplify/data/resource.ts` (after `homePetVaccine`) |
| Janet tools: `get_pregnancy_status`, `set_pregnancy`, `list_care_items`, `manage_care_item`, `manage_health_provider`, `log_medical_visit`, `list_medical_visits`, `add_visit_question`, `record_lab_results`, `list_lab_results` | `amplify/functions/agent/handler.ts` (tool defs after `list_attachments`; cases before `default`; "Health records & pregnancy" section in the system prompt; the pregnancy status line is injected into the prompt) |
| *Baby* section in the daily summary (GA, new-week callout, overdue / due-now / soon items) | `amplify/functions/daily-summary/handler.ts` (`gatherPregnancies`) |
| `/health` web page + "Health" entry in the Life nav menu | `pages/health.tsx`, `components/navbar.tsx` |
| Roadmap for later phases | `ROADMAP.md` → "Baby / health" |

Design decisions:
- **Due date is the anchor**, not the LMP. `set_pregnancy` with a new `dueDate` shifts open timeline items that have a template `key`. Hand-added items (null key) and closed items keep their dates. Only the seasonal vaccines have their UPCOMING ⇄ N/A status recomputed; any other N/A was a human decision and stays.
- **Lab results are one row per value**, so values can be charted and looked up directly. PENDING rows are filled in place, matched by `testName`. A linked care item becomes DONE once none of its results are pending.
- **Calendar events still own appointment times.** A visit links to the event via `eventId`. PLANNED visits collect questions for the doctor.
- The RSV vaccine comes out **N/A** for this pregnancy (32–36w falls in April, outside the Sep–Jan season), so the plan is nirsevimab for the baby. The flu vaccine shows "due now".

## Verified
- `npx vitest run`: 53/53 passing, including the CDK synth and `next build`.
- `tsc --noEmit` is clean for the web and `amplify/` projects.
- ESLint is broken repo-wide (`typescript-eslint` package missing). This predates phase 1.
- **Not tested against real data.** Nothing has been deployed or invoked yet.

## Next steps
1. Review, then merge `baby-health` → `main` and deploy (Amplify deploys the schema and Lambdas). Regenerate `mobile/amplify_outputs.json` if the mobile app needs the new models.
2. Smoke test on WhatsApp: *"Track a pregnancy for <her name>, last period Aug 20. OB appointments Oct 12 at <time> and Oct 14 at <time>."* Then check `/health`: 21 care items, 2 planned visits, and the flu vaccine due now.
3. Next phases, per ROADMAP.md:
   - File lab PDFs as MEDICAL `homeDocument` (Duo-gated) and link `documentId`.
   - Person-level medications and supplements (generalize `homePetMedication`), plus curated trimester nutrition notes.
   - Mobile `more/health` screen. Later: kick counter, contraction timer, and a go-time button.
   - `PREGNANCY` entity type for checklists (hospital bag, nursery, car seat).
   - Household inventory: WISHLIST status doubles as the registry; low-stock thresholds add items to the shopping list.
   - Finance, in the **gennaroanesi.com** repo: a "Baby" spend group, a savings goal targeting the due date, and a "with baby" planning scenario. This is time-sensitive, because open enrollment is in November and delivery falls in the 2027 plan year.
   - Newborn log (feeds, diapers, sleep) by about 32 weeks.

## Leave alone
These untracked files in home-hub predate this work and aren't part of it: `1x/`, `app.json`, `eas.json`, `scripts/send-smartthings-test.mjs`.
