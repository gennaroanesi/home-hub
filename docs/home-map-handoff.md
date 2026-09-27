# House map — handoff

Status as of 2026-09-26: the code is committed on `main` but **not pushed or deployed**. The **lot is traced**; that file is ready to import once the backend is deployed. Both floors are waiting on the floor plans.

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

## Verified
- The web, `amplify/` and `mobile/` type-checks are clean. `npx vitest run` passes 89/89, including 21 floor-plan tests, the CDK synth and `next build`.
- The lot SVG was rendered with headless Chrome and checked by eye: every label is readable (vertical labels in the side strips) and the pieces add up to the lot area.
- **Not yet run against a deployed backend.** The pages weren't loaded in a browser; the dev server was down, so only `next build` compiled them.

## Next steps
1. **Deploy** after the user OKs the push, then regenerate `amplify_outputs.json` for localhost and mobile.
2. **Import the lot** on `/map` after the deploy.
3. **Trace the floor plans:** the user sends images of both floors and the garage plus known room dimensions. Trace the outlines in feet, using the given measurements as the scale (they win over the drawing). Render a preview for the user to check, then hand over the JSON to import on `/map`.
4. **Later:**
   - Show Home Assistant devices in their room (match `homeRoom.haArea` to `homeDevice.area`).
   - Color rooms by what they contain.
   - A mobile map screen.
   - A photo per room or storage spot.
