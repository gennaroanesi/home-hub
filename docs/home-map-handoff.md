# House map — handoff

Status as of 2026-09-26: everything below is deployed (build 167, `1476951`): photo → inventory through Janet as drafts, pets as owners, and the Drafts review. The user has imported the lot and first floor; the second floor (`~/Downloads/house-map-second-floor.json`) is ready to import. `mobile/amplify_outputs.json` is regenerated but not pushed (it only affects mobile). **Not yet tried:** Janet on a real photo.

**Keep this doc current.** Update it, and the *House map* entry in `ROADMAP.md`, in every commit that touches this work.

## Goal
A to-scale map of the house under **Home → Map**: two floors plus the garage. Inventory items link to the room they're kept in, so "where is X?" has an answer. It's an SVG so we can build on it later (devices, rooms colored by what they contain, …).

## Decisions (from the user)
- **Units:** feet and inches.
- **Closets are rooms,** stored as kind `CLOSET` or `STORAGE` with `parentRoomId` pointing to the room they open off. A lot is stored in closets, so they need their own records.
- **Inventory keeps free text:** `roomId` says which room ("Primary bedroom › Closet"), and `location` holds the detail within it ("over the closet, gray box").
- **Outdoors:** the garage, plus a **Lot** level (level 0) traced from the builder's plot plan. The lot is useful for sod and yardage: yards show sq yd.

## What's built
| Piece | Where |
|---|---|
| Models: `homeFloor` (name, level; 0 = the lot / site plan); `homeRoom` (floor, name, kind including the site kinds LOT / FOOTPRINT / YARD / HARDSCAPE, parentRoomId, `points: RoomPoint[]` in feet, optional label position, `haArea`, notes); `homeInventoryItem.roomId` (indexed) | `amplify/data/resource.ts` |
| Feet-and-inches parsing and formatting, geometry (area, centroid, bbox, rectangles), to-scale SVG builder (1 unit = 1 ft; embedded styles with a dark variant; `data-room-id` groups; 10-ft scale bar), import/export format, room labels / nesting / fuzzy matching | `lib/floorplan.ts`, tests in `lib/floorplan.test.ts` |
| `/map`: floor tabs; click a room to see size, closets and what's stored there (closets roll up into their room); add or edit rooms as a rectangle (x/y/width/depth in ft-in) or an outline (one `x, y` per line); floor CRUD; **Import** JSON (matches floors by name and rooms by floor + name, so re-imports update shapes and keep inventory links); **Export** SVG per floor and JSON for everything | `pages/map.tsx`, nav entry in `config/nav.ts` |
| Inventory: a Room field plus "Where in the room"; a room filter (includes closets); room shown on each row; `/inventory?roomId=…&new=1` deep links from the map | `pages/inventory.tsx` |
| Janet: `list_inventory` takes `roomName` (includes closets) and returns `room` on each item; `manage_inventory_item` takes `roomName`; the prompt covers "where is X?" and "put X in the garage" | `amplify/functions/agent/handler.ts` |

## Import format
```json
{
  "version": 1,
  "floors": [
    { "name": "First floor", "level": 1,
      "rooms": [
        { "name": "Primary bedroom", "kind": "BEDROOM",
          "points": [[0,0],[14,0],[14,"12'6\""],[0,"12'6\""]] },
        { "name": "Primary closet", "kind": "CLOSET", "parent": "Primary bedroom",
          "rect": { "x": 14, "y": 0, "width": "6'", "depth": "5'6\"" } }
      ] }
  ]
}
```
- **Coordinates:** feet from the floor's top-left corner, with x to the right and y down. Each value is a number or a feet-and-inches string.
- **Room kinds:** ROOM, BEDROOM, BATHROOM, KITCHEN, LIVING, DINING, OFFICE, LAUNDRY, HALLWAY, STAIRS, CLOSET, STORAGE, GARAGE. For the site plan: LOT, FOOTPRINT, YARD, HARDSCAPE. Plus OTHER.
- **Label position:** a room can include `"label": [x, y]` to place its name. Names in narrow, tall spaces are drawn vertically.

## The lot (traced 2026-09-26)
Source: the builder's plot plan (ATS, 2021-08-13, scale 1" = 20'). North is up and the street is at the bottom. The origin is the back-left (NW) corner.
- **Exact, from printed dimensions:**
  - lot 45' × 120' (5,400 sq ft)
  - house 34'-11" wide and 73'-5½" deep overall
  - side setbacks 5'-0½"
  - rear 31'-0½", front 15'-6"
  - rear fence 37'-0¼" deep
  - drive 17' wide
- **Measured off the drawing:** the rear wall about 7' in from the patio edge, the garage face about 24' from the front line, the front bump, the walk and the A/C pad. Check: the traced footprint is 2,178 sq ft against the builder's slab of 2,192 sq ft.
- **Lawn:** backyard 167 yd² (builder 173); front plus sides 120 yd² (builder 134, which includes the right-of-way strip). The builder's sod table is in the lot's notes.
- **Open question:** the covered patio is marked "optional" on the plan. Delete it if it wasn't built.
- The import file is not in the repo, because it holds the address. It was handed to the user directly.

## The first floor (traced 2026-09-26)
Source: Meritage's marketing plan "The Reynolds / Plan 890", first floor (REV 01/21). It isn't dimensioned and says it may not be to scale.
- **Scale:** the house's outside width (34'-11" from the plot plan) spread across the drawing's outside walls.
- **Cross-checks:** the garage face lands 58' from the rear wall, which the plot plan matches exactly. The porch front is about 1' from the plot plan's figure.
- **Rooms are measured to wall centers,** so they tile the footprint. Stated sizes run about half a wall thicker than the rooms really are.
- **Origin:** the house's back-left outside corner. The covered outdoor living sits at negative y.
- **18 spaces:** Family, Dining, Kitchen (+ Pantry), Primary suite (+ Primary bath (+ Linen), + Primary closet), Laundry, Foyer (+ Coats), Stairs, Bath 3, Bedroom 5 (+ closet), Garage, Porch, Covered outdoor living.
- **What the DWGs contain:** the Meritage DWGs, one per floor, aren't vector plans. Each holds the plan as a raster image, with a few hand-drawn items on top (appliances, and 5 dimensions on floor 1, 14 on floor 2) in real inches (`INSUNITS=1`). The floor-1 dimensions confirmed the scale to within about 2%: family 17'-4" wide, primary suite 15'-6" × 15'-6", family + dining 30'-11" deep, all interior. Read with `@mlightcad/libredwg-web` (WASM), installed only in the scratchpad; Homebrew's libredwg was blocked by an unaccepted Xcode license.
- **Lot kept in step:** the lot's house footprint now uses the floor plan's front bump (Bedroom 5 + foyer, 15'-5" wide), with the porch and walk in front of it.
- **Covered patio:** the user confirmed the larger, "optional" covered patio from the plot plan (about 28' × 7') was built. Both the lot and the first floor use it; the marketing plan shows the standard 18'-5" × 6'-4".

## The second floor (traced 2026-09-26)
Source: the Plan 890 second-floor marketing plan, at the same scale as the first floor (the house's 34'-11" width).
- **Placement:** the rear wall sits over the first floor's Family / Primary suite front wall (y = 16'), so the load-bearing walls stack. That also puts the upper stair flight over the first-floor stairs, within about 0.5'. The game room ends about 5' behind the garage face. Bedroom 5 and the porch are one-story.
- **Rejected alternative:** front flush with the garage. That puts the stairs across the primary closet.
- **13 spaces:** Bedrooms 2, 3 and 4 (each with a closet), Bath 2, Upstairs hall (+ Linen), Storage, Stairs, Study, Game room.
- **Floor-2 DWG:** its 14 dimensions use a different underlay scale from floor 1 (interior width 413" vs 398"), so they're only proportions. They weren't used as measurements.

## Zoom and pan
`components/floor-map.tsx` wraps the generated SVG and drives its `viewBox`:
- **Controls:** + / − / Fit buttons; pinch or ⌘/Ctrl + scroll zooms around the cursor; drag pans; two-finger scroll pans only once zoomed in, otherwise the page scrolls.
- **Rooms:** tapping a room selects it and eases the view to frame it (`fitViewBox`: the drawing's aspect ratio, at least 12' across). Selecting from the side panel does the same. Deselecting (tap the room again, or tap empty space) eases back to the whole floor.
- **State:** the view survives re-renders (selection, badges) and resets when switching floors. The math is in `lib/floorplan.ts` (`zoomViewBox`, `clampViewBox`, `fitViewBox`), with tests.
- **Not yet tried in a real browser;** it needs a human with a mouse and trackpad.

## Photo → inventory (Janet)
Send Janet a photo on WhatsApp or in the web chat with where it is ("garage, second shelf"). She identifies each distinct item and calls **`add_inventory_items`** once. That creates every item in the room at the given location, with this message's photo attached (`homeInventoryItem.imageKeys`), plus clothing/consumable detail rows. Items are created as **DRAFT**, with `draftStatus` = what they become (OWNED, or WISHLIST for things to buy). She replies with a numbered list. You approve ("looks good") or correct: `review_inventory_drafts` approves or discards by id or `all`, and quantity/owner fixes go through `manage_inventory_item`. On a later WhatsApp turn she no longer has the ids (the history holds text only), so she lists the pending drafts first.
- **Drafts don't count anywhere:** not in totals, wishlist sums, map badges, low-stock refills, or `list_inventory`'s default (OWNED). The web **Drafts** tab (shown only when there are drafts; the page lands on it) has Approve / Discard per item and Approve all / Discard all. The map's room panel lists drafts tagged "(Draft)".
- **Shared helpers:** `approveDrafts` / `deleteInventoryItems` in `lib/inventory.ts` (tested with a fake client), used by both the page and Janet.
- **Created right away, as drafts:** the WhatsApp history doesn't carry photos into later turns, so waiting for a "yes, add them" before creating anything would lose the photo. The draft status is the approval step instead.
- **How the photo reaches the tool:** `ToolContext.currentImageKeys`, filled from the inbound message's image attachments (async/WhatsApp) or `imageS3Keys` (web).
- **Guardrails:** if she doesn't know the room she asks first, since the prompt says to. If the room or owner doesn't resolve, nothing is created. Max 60 items per call.
- **Photos in the app:** a thumbnail on inventory rows and in the map's room panel; full photos in the item dialog, where one can be removed. URLs come from `lib/image-loader` (`photoUrl`).

## Pets as owners
`homeInventoryItem.petId` (indexed). The web owner picker/filter lists active pets ("🐶 Dolce"). Janet resolves pet names in `ownerName` (`resolveInventoryOwner` → exactly one of `ownerPersonId` / `pregnancyId` / `petId`), and `list_inventory` shows the pet as the owner.

## Storage
Importing writes floors and rooms into the database (`homeFloor` / `homeRoom`). The JSON file is only a way in, so nothing needs re-uploading. Re-importing is only for corrections: it upserts by floor + room name, so inventory links survive.

## Documents
`homeDocument.type` gained **PROPERTY** for house papers, with labels on web and mobile and in Janet's filter. The Documents page is how files get stored: it creates the S3 object and the record together. This environment has no write access to the database, so the user uploads the plot plan and both floor-plan PDFs there. The DWGs can't be uploaded: Documents accepts PDF and images only, and the DWGs add nothing beyond the dimensions already used.

## Verified
- The web, `amplify/` and `mobile/` type-checks are clean. `npx vitest run` passes 89/89, including 21 floor-plan tests, the CDK synth and `next build`.
- The lot SVG was rendered with headless Chrome and checked by eye: every label is readable (vertical labels in the side strips) and the pieces add up to the lot area.
- **Not yet run against a deployed backend.** The pages weren't loaded in a browser; the dev server was down, so only `next build` compiled them.

## Next steps
1. ~~Deploy~~ Done: build 165.
2. **Import** `house-map.json` on `/map` after the deploy, and upload the PDFs to Documents as Property.
3. ~~Trace the second floor~~ Done. **Import** `house-map-second-floor.json`.
4. **Earlier plan for tracing floor plans:** the user sends images of both floors and the garage plus known room dimensions. Trace the outlines in feet, using the given measurements as the scale (they win over the drawing). Render a preview for the user to check, then hand over the JSON to import on `/map`.
5. **Later:**
   - Show Home Assistant devices in their room (match `homeRoom.haArea` to `homeDevice.area`).
   - Color rooms by what they contain.
   - A mobile map screen.
   - A photo per room or storage spot.
