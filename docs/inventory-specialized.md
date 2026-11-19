# Specialized inventory (moving gennaroanesi.com's inventory here)

Status: 2026-11-19. Steps 1–4 done: owner-only check, schema + `lib/inventory-details.ts`, ops (`lib/ops/inventory-items.ts`, `lib/inventory-store.ts`, `lib/inventory-ammo.ts`), web (`/inventory` reads and saves through the ops; `components/inventory/detail-fields.tsx`, `ammo-panel.tsx`). Not yet: the house map's item counts read `homeInventoryItem` directly, so owner-only items don't show there.

## Why

gennaroanesi.com has an admin-only inventory with detail tables for
firearms, ammo, 3D-printer filament, instruments, photography and
electronics (`inventoryItem` + `inventory<Type>`), ammo usage logging and
per-caliber low-ammo alerts. Home-hub has the household inventory
(`homeInventoryItem` + `homeInventoryClothing` / `homeInventoryConsumable`,
an editable category tree whose `detailType` picks the detail model) but no
phone screen. Decisions (2026-11-19):

- Bring **all six** types; home-hub becomes the only inventory.
- **Migrate** the old data (items, details, parts, photos, ammo alert levels)
  and retire the inventory on gennaroanesi.com.
- **Firearms and ammo are owner-only**: other household members can't see
  them on any surface. Everything else stays household-visible.

## Design

### 1. One detail model per type, picked by the category

Same pattern as clothing / consumables. `homeInventoryCategory.detailType`
gains `FIREARM`, `AMMO`, `FILAMENT`, `INSTRUMENT`, `PHOTOGRAPHY`,
`ELECTRONIC`; each has a `homeInventory<Type>` model keyed by `itemId`
(1:1, `index("itemId")`). Subcategories inherit the type, so "Firearms ›
Handguns" and "Music › Pedals" just work. Seeded categories: Firearms,
Ammo, 3D printing › Filament, Music › Instruments, Photography,
Electronics (renamed/re-nested freely afterwards).

Fields carry over from gennaroanesi.com, with two changes:

- **Count lives on the base item.** `homeInventoryItem.quantity` is "how
  many of this"; the old per-type `quantity` (filament spools, electronic
  parts) maps onto it. Ammo is the exception: one item is one lot
  (a purchase of one load), and its detail holds `roundsPerBox`,
  `roundsAvailable` (on hand) and `roundsPurchased`.
- **Parts become items.** The old embedded `FirearmPart[]` /
  `InstrumentPart[]` arrays turn into child items via a new
  `homeInventoryItem.parentItemId` ("installed on / belongs to"): an optic
  on a rifle, pickups in a guitar, a lens hood on a lens. They get price,
  photos, brand and dates like anything else, the parent's page lists
  them, and its value includes them.

### 2. One field spec drives every surface

`lib/inventory-details.ts`: per detail type, its fields (key, label, kind
text / int / float / enum / bool / date, options, unit, presets), the
summary line ("9mm · 115gr FMJ · 850 rds"), list columns, and whether
it's private. The web form, the phone form, the ops' zod input/output and
Janet's tool descriptions are all generated from it. Adding a type later
= one model + one spec entry. Clothing and consumables move onto it too.

### 3. Ops, not agent tools

Inventory items today are legacy tools inside the agent Lambda, which the
phone can't call. They move into `lib/ops/inventory.ts` (list / get /
save / adjust quantity / drafts / photos), with detail fields from the
spec, so web, phone, Janet and `hh` share them. New:

- `log_ammo_use` (caliber or item, rounds, date, note): drains the oldest
  lots first (by `acquiredAt`), like the old site, and records a
  `homeInventoryUsage` row (item, date, amount, note, person) so there's a
  history ("200 rounds of 9mm on Saturday").
- `get_ammo_summary`: rounds on hand per caliber against its minimum.
- `save_ammo_threshold`: `homeAmmoThreshold { caliber, minRounds, enabled }`.
  When a use or edit drops a caliber below its minimum, the owner gets a
  WhatsApp DM (no DynamoDB stream Lambda, the op checks after writing).

### 4. Owner-only firearms and ammo

A detail type's spec says `private: true` (FIREARM, AMMO). Private items
can't live in `homeInventoryItem`, whose `home-users` group rule lets every
household login read every row. So:

- `homePrivateInventoryItem`: the same base fields (one shared field
  definition in the schema), plus `ownerUsername`, with an owner rule
  (`allow.ownerDefinedIn("ownerUsername").identityClaim("username")`).
  The firearm / ammo detail models, `homeInventoryUsage` rows for them and
  `homeAmmoThreshold` use the same rule.
- Code reads items through one helper (`listInventoryItems`) that merges
  both tables, so pages and ops don't care where a row lives. Saving into
  a private category writes the private table (moving the row if needed).
- **Web** reads AppSync directly as the user, so the owner rule enforces it.
- **Phone / `hh`** go through the ops Lambda, which today doesn't know who's
  calling. It gets `actor.personId` from the AppSync identity; ops return
  private items only to their owner.
- **Janet** knows the sender; private items are never listed or named in
  the household group chat ("ask me in a DM"), only in the owner's DM.

Verified in the sandbox (2026-11-19) with a model carrying only
`allow.ownerDefinedIn("ownerUsername").identityClaim("username")`: the ops
Lambda reads and writes it through the schema-level `allow.resource`
grant alone; the owner lists and gets it; another `home-users` login lists
nothing, gets / updates / creates-as-owner are refused, and neither login
gets in with IAM (identity pool) auth. So private models must **not** carry
`allow.authenticated("identityPool")`, and Lambdas that need them must be
in the schema-level `allow.resource` list. The `username` claim is the
Cognito username, i.e. `homePerson.cognitoUsername`.

### 5. Screens

- **Web `/inventory`**: detail fields from the spec in the item form and
  rows; type views where they help: ammo grouped by caliber with totals,
  minimums and "Log use"; filament by material with color swatches;
  firearms with serial numbers; parts listed under their parent.
- **Phone, new More → Inventory**: search; filter by category, owner,
  status (owned / wishlist); item detail with photos, spec fields, parts;
  add / edit form generated from the spec; quantity +/-; ammo "Log use"
  and caliber totals. Barcode scanning stays a later step.

### 6. Migration and retiring the old inventory

`scripts/import-gennaroanesi-inventory.ts`, run once against both prods,
idempotent (each imported row keeps `importedFrom: "gennaroanesi:<id>"`):

- Every `inventoryItem` + detail → base item (owner Gennaro) + detail in
  the matching category; `active`/`status` → status; parts → child items.
- Photos copied from the old bucket's `inventory/{id}/` to
  `home/inventory/{newId}/`.
- `ammoThreshold` → `homeAmmoThreshold`.
- Dry run first with counts per type, then the write, then a read-back.

Then on gennaroanesi.com: export every inventory table to a JSON backup in
S3, remove the inventory pages, the Gennaro-agent inventory tools and the
`checkAmmoThresholds` Lambda, and finally the models (deleting a model
drops its table, so only after the backup and a check here).

## Build order

1. Verify owner-only access in the sandbox (section 4).
2. Schema: detail types, six detail models, private base table,
   `parentItemId`, usage, thresholds, `importedFrom`; the field spec.
3. Ops: move the item tools out of the agent, add ammo ops and the actor
   identity; Janet uses them.
4. Web: spec-driven form and rows, type views, parts.
5. Phone: Inventory screen (needs an OTA).
6. Migration: dry run, import, check together.
7. Retire on gennaroanesi.com.
