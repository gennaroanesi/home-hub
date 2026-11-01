---
name: home-hub-cli
description: Read or change live Home Hub data (wardrobe items and wishlist, trips, trip plans, tasks, inventory, shopping lists, calendar…) from the terminal with `npm run hh`. Use this instead of writing a one-off script whenever the user asks to look something up or change something in their household data, e.g. "add this to my wishlist", "mark the polo as arrived", "what's in my Seattle packing list". Not for schema or code changes.
---

# Home Hub CLI (`hh`)

`hh` is generated from the external API spec (`/api/v1`), so every operation
Janet and API clients have is a command, with the same validation and rules as the app.
It talks to **production**. See `docs/ops-architecture.md`.

Run from the home-hub repo root. It reads `MUSE_API_KEY` (and optionally
`HOME_HUB_URL`) from `.env.local`; never print those values. It acts as the
API's `MUSE_SENDER` household member, so "my" means that person unless you
pass `--personName`.

## Commands

```bash
npm run hh                                   # list operations: R read, W write, ? legacy (may write)
npm run hh -- help <operation>               # description + every parameter
npm run hh -- <operation> --param value …    # run it
```

- Flags are typed from the spec. Repeat a flag for arrays, or pass JSON:
  `--imageUrls '["https://…/a.jpg"]'`. `--json '{…}'` merges a whole input.
- Output is the JSON result on stdout; errors go to stderr as JSON with exit 1
  (a duplicate save returns the existing item in `details`).

## Writes

Anything that isn't `R` is a **dry run** unless `--yes`. Always:

1. Run it without `--yes` and check the printed input.
2. Confirm with the user before re-running with `--yes`, unless they
   already asked for exactly this change in this conversation.
3. Read back the result (or run the matching list/get op) and report what
   actually changed.

Never use `--yes` to "test" an operation against real records. If a test
record is unavoidable, name it `API TEST — delete me` and remove it after.

## Examples

```bash
npm run hh -- list_wardrobe --status WISHLIST --limit 10
npm run hh -- list_wardrobe --query "navy polo"
npm run hh -- save_wardrobe_item --name "Cotton piqué polo" --category Tops --brand Sunspel \
  --price 135 --url https://… --imageUrls https://cdn…/front.jpg            # dry run
npm run hh -- save_wardrobe_item --itemId <id> --status KEEP --yes          # wishlist piece arrived
npm run hh -- get_trip_plan --tripName Seattle
```

## Limits

- Photos: pass product image links (`--imageUrls`). Local files need the
  `/uploads` presigned flow, which `hh` doesn't do; ask the user to run
  their upload script instead.
- Operations marked `?` are legacy agent tools without typed output; read
  `help` and treat them as writes.
- No delete for wardrobe items over the API by design; use `--status RETIRE`.
- If an operation you need doesn't exist, it belongs in `lib/ops/` (see the
  architecture doc), not in a one-off script.
