// House map: units, geometry, SVG rendering and the import format.
//
// Rooms are outlines in FEET measured from the floor's top-left corner
// (x → right, y → down). The SVG uses feet as its user unit, so the
// drawing is to scale by construction; the same builder feeds the /map
// page and the "Export SVG" download.

// ── Feet & inches ────────────────────────────────────────────────────────────

/**
 * Parse a length into decimal feet. Accepts 12'6", 12' 6", 12 ft 6 in,
 * 12ft6in, 12'6, 12-6, 150" / 150 in (inches only), or a plain number
 * (feet). Returns null when it can't make sense of the input.
 */
export function parseFeetInches(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  const s = input.trim().toLowerCase().replace(/[′’]/g, "'").replace(/[″”“]/g, '"').replace(/''/g, '"');
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);

  const inchesOnly = s.match(/^(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)$/);
  if (inchesOnly) return Number(inchesOnly[1]) / 12;

  const ftIn = s.match(
    /^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot|-)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?)?$/,
  );
  if (ftIn) {
    const inches = ftIn[2] ? Number(ftIn[2]) : 0;
    if (inches >= 12) return null;
    return Number(ftIn[1]) + inches / 12;
  }
  return null;
}

/** 12.5 → 12′ 6″, rounded to the nearest inch. */
export function formatFeetInches(feet: number): string {
  const totalInches = Math.round(feet * 12);
  const ft = Math.floor(totalInches / 12);
  const inch = totalInches - ft * 12;
  return inch === 0 ? `${ft}′` : `${ft}′ ${inch}″`;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export function rectPoints(x: number, y: number, width: number, depth: number): Point[] {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + depth },
    { x, y: y + depth },
  ];
}

export function bounds(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number; width: number; depth: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, depth: maxY - minY };
}

/** Shoelace area in square feet. */
export function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Area-weighted centroid; falls back to the bbox center for degenerate shapes. */
export function centroid(points: Point[]): Point {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const b = bounds(points);
    return { x: b.minX + b.width / 2, y: b.minY + b.depth / 2 };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** A rectangle's outline is 4 points with axis-aligned edges. */
export function isRectangle(points: Point[]): boolean {
  if (points.length !== 4) return false;
  const b = bounds(points);
  return points.every(
    (p) => (p.x === b.minX || p.x === b.maxX) && (p.y === b.minY || p.y === b.maxY),
  );
}

/** "12′ 6″ × 10′" for rectangles; "142 sq ft" otherwise. */
export function describeSize(points: Point[]): string {
  if (points.length < 3) return "";
  if (isRectangle(points)) {
    const b = bounds(points);
    return `${formatFeetInches(b.width)} × ${formatFeetInches(b.depth)}`;
  }
  return `${Math.round(polygonArea(points))} sq ft`;
}

// ── SVG ──────────────────────────────────────────────────────────────────────

export interface RoomShape {
  id: string;
  name: string;
  kind?: string | null;
  points: Point[];
  labelX?: number | null;
  labelY?: number | null;
}

export interface FloorSvgOptions {
  selectedRoomId?: string | null;
  /** Small badge per room, e.g. inventory item counts. */
  badges?: Record<string, number>;
  /** Draw the size under each room name (default true). */
  showSizes?: boolean;
  title?: string;
}

const PAD = 2; // feet of margin around the drawing

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

const SMALL_KINDS = new Set(["CLOSET", "STORAGE", "STAIRS", "HALLWAY", "HARDSCAPE"]);

/**
 * Standalone, to-scale SVG for one floor (1 user unit = 1 foot). Rooms
 * are <g class="room" data-room-id="…"> so the page can handle clicks by
 * delegation. Styles live in an embedded <style> with a dark-mode
 * variant, so the exported file looks right on its own.
 */
export function buildFloorSvg(rooms: RoomShape[], opts: FloorSvgOptions = {}): string {
  const drawable = rooms.filter((r) => r.points.length >= 3);
  const all = drawable.flatMap((r) => r.points);
  const b = all.length ? bounds(all) : { minX: 0, minY: 0, width: 20, depth: 20, maxX: 20, maxY: 20 };
  const vbX = r2(b.minX - PAD);
  const vbY = r2(b.minY - PAD);
  const vbW = r2(b.width + PAD * 2);
  const vbH = r2(b.depth + PAD * 2 + 2); // + room for the scale bar
  const showSizes = opts.showSizes !== false;

  // Bigger rooms first so closets draw on top.
  const ordered = [...drawable].sort((a, c) => polygonArea(c.points) - polygonArea(a.points));

  // Two passes: shapes first (big → small, so closets sit on top), then
  // every label above all shapes so nothing hides a name. Narrow, tall
  // spaces (side yards, hallways) get vertical labels.
  const shapeEls: string[] = [];
  const labelEls: string[] = [];
  for (const room of ordered) {
    const pts = room.points.map((p) => `${r2(p.x)},${r2(p.y)}`).join(" ");
    const c = room.labelX != null && room.labelY != null ? { x: room.labelX, y: room.labelY } : centroid(room.points);
    const rb = bounds(room.points);
    const kindClass = `kind-${(room.kind ?? "ROOM").toLowerCase()}`;
    const small = SMALL_KINDS.has(room.kind ?? "") || Math.min(rb.width, rb.depth) < 6;
    const fs = small ? 0.55 : 0.8;
    const classes = ["room", kindClass];
    if (room.id === opts.selectedRoomId) classes.push("selected");
    const badge = opts.badges?.[room.id];
    const size = showSizes && !small ? describeSize(room.points) : "";
    shapeEls.push(
      [
        `<g class="${classes.join(" ")}" data-room-id="${esc(room.id)}">`,
        `<title>${esc(room.name)}${size ? ` — ${esc(size)}` : ""}</title>`,
        `<polygon points="${pts}"/>`,
        `</g>`,
      ].join(""),
    );

    // Vertical when the name wouldn't fit across but would fit down.
    const approxWidth = room.name.length * fs * 0.62; // ~0.6em per character
    const vertical = approxWidth > rb.width * 0.9 && rb.depth > rb.width;
    const rotate = vertical ? ` transform="rotate(-90 ${r2(c.x)} ${r2(c.y)})"` : "";
    const lines = [
      `<text class="label ${kindClass}" x="${r2(c.x)}" y="${r2(c.y - (size ? fs * 0.35 : -fs * 0.35))}" font-size="${fs}"${rotate}>${esc(room.name)}</text>`,
      size ? `<text class="size" x="${r2(c.x)}" y="${r2(c.y + fs * 0.85)}" font-size="${r2(fs * 0.75)}"${rotate}>${esc(size)}</text>` : "",
      badge
        ? `<g class="badge"><circle cx="${r2(rb.maxX - 0.8)}" cy="${r2(rb.minY + 0.8)}" r="0.6"/><text x="${r2(rb.maxX - 0.8)}" y="${r2(rb.minY + 1)}" font-size="0.6">${badge}</text></g>`
        : "",
    ];
    labelEls.push(lines.join(""));
  }
  const roomEls = [...shapeEls, `<g class="labels">`, ...labelEls, `</g>`].join("\n");

  // 10-foot scale bar under the drawing.
  const sbY = r2(b.maxY + 1.8);
  const sbX = r2(b.minX);
  const scaleBar = [
    `<g class="scale">`,
    `<line x1="${sbX}" y1="${sbY}" x2="${r2(sbX + 10)}" y2="${sbY}"/>`,
    `<line x1="${sbX}" y1="${r2(sbY - 0.3)}" x2="${sbX}" y2="${r2(sbY + 0.3)}"/>`,
    `<line x1="${r2(sbX + 10)}" y1="${r2(sbY - 0.3)}" x2="${r2(sbX + 10)}" y2="${r2(sbY + 0.3)}"/>`,
    `<text x="${r2(sbX + 10.6)}" y="${r2(sbY + 0.25)}" font-size="0.7">10 ft</text>`,
    `</g>`,
  ].join("");

  const style = `
    .room polygon { fill: #eef2f6; stroke: #5b6573; stroke-width: 0.12; stroke-linejoin: round; }
    .room.kind-closet polygon, .room.kind-storage polygon { fill: #f6f1e7; }
    .room.kind-bathroom polygon { fill: #e9f3f5; }
    .room.kind-garage polygon { fill: #efefef; }
    .room.kind-hallway polygon, .room.kind-stairs polygon { fill: #f7f7f8; }
    .room.kind-lot polygon { fill: none; stroke: #6b7280; stroke-width: 0.18; stroke-dasharray: 1 0.6; }
    .label.kind-lot { fill: #6b7280; font-weight: 500; }
    .labels { pointer-events: none; }
    .room.kind-footprint polygon { fill: #e5e7eb; stroke: #374151; stroke-width: 0.2; }
    .room.kind-yard polygon { fill: #e3f1dc; stroke: #7aa66a; stroke-width: 0.1; }
    .room.kind-hardscape polygon { fill: #e7e5e4; stroke: #a8a29e; stroke-width: 0.1; }
    .room:hover polygon { fill: #dde7f3; cursor: pointer; }
    .room.selected polygon { fill: #cfe0f7; stroke: #2563eb; stroke-width: 0.2; }
    .label, .size, .scale text, .badge text { font-family: system-ui, -apple-system, sans-serif; text-anchor: middle; }
    .label { fill: #1f2937; font-weight: 600; pointer-events: none; }
    .size { fill: #6b7280; pointer-events: none; }
    .scale line { stroke: #6b7280; stroke-width: 0.1; }
    .scale text { fill: #6b7280; text-anchor: start; }
    .badge circle { fill: #2563eb; }
    .badge text { fill: #fff; font-weight: 700; pointer-events: none; }
    @media (prefers-color-scheme: dark) {
      .room polygon { fill: #1f2937; stroke: #9ca3af; }
      .room.kind-closet polygon, .room.kind-storage polygon { fill: #2a2620; }
      .room.kind-bathroom polygon { fill: #1c2a2e; }
      .room.kind-garage polygon, .room.kind-hallway polygon, .room.kind-stairs polygon { fill: #232323; }
      .room.kind-lot polygon { fill: none; stroke: #9ca3af; }
      .room.kind-footprint polygon { fill: #2b2f36; stroke: #d1d5db; }
      .room.kind-yard polygon { fill: #1e2b1a; stroke: #4d7a40; }
      .room.kind-hardscape polygon { fill: #292524; stroke: #57534e; }
      .room:hover polygon { fill: #26344a; }
      .room.selected polygon { fill: #1e3a5f; stroke: #60a5fa; }
      .label { fill: #f3f4f6; }
      .size, .scale text { fill: #9ca3af; }
      .scale line { stroke: #9ca3af; }
    }`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="100%" preserveAspectRatio="xMidYMid meet" role="img"${opts.title ? ` aria-label="${esc(opts.title)}"` : ""}>`,
    opts.title ? `<title>${esc(opts.title)}</title>` : "",
    `<style>${style}</style>`,
    roomEls,
    scaleBar,
    `</svg>`,
  ].join("\n");
}

// ── Import / export format ───────────────────────────────────────────────────
//
// {
//   "version": 1,
//   "floors": [
//     { "name": "First floor", "level": 1,
//       "rooms": [
//         { "name": "Primary bedroom", "kind": "BEDROOM",
//           "points": [[0,0],[14,0],[14,12.5],[0,12.5]] },
//         { "name": "Primary closet", "kind": "CLOSET", "parent": "Primary bedroom",
//           "rect": { "x": 14, "y": 0, "width": "6'", "depth": "5'6\"" } }
//       ] }
//   ]
// }
//
// A room gives either `points` ([x, y] pairs in feet) or `rect` (x/y/
// width/depth, each a number of feet or a feet-and-inches string).
// `parent` names another room on the same floor. Re-importing matches
// floors by name and rooms by (floor, name), so geometry updates in place
// and inventory links survive.

export const ROOM_KINDS = [
  "ROOM",
  "BEDROOM",
  "BATHROOM",
  "KITCHEN",
  "LIVING",
  "DINING",
  "OFFICE",
  "LAUNDRY",
  "HALLWAY",
  "STAIRS",
  "CLOSET",
  "STORAGE",
  "GARAGE",
  "LOT",
  "FOOTPRINT",
  "YARD",
  "HARDSCAPE",
  "OTHER",
] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

export const ROOM_KIND_LABELS: Record<RoomKind, string> = {
  ROOM: "Room",
  BEDROOM: "Bedroom",
  BATHROOM: "Bathroom",
  KITCHEN: "Kitchen",
  LIVING: "Living",
  DINING: "Dining",
  OFFICE: "Office",
  LAUNDRY: "Laundry",
  HALLWAY: "Hallway",
  STAIRS: "Stairs",
  CLOSET: "Closet",
  STORAGE: "Storage",
  GARAGE: "Garage",
  LOT: "Lot boundary",
  FOOTPRINT: "House footprint",
  YARD: "Yard / lawn",
  HARDSCAPE: "Paved (drive, walk, patio)",
  OTHER: "Other",
};

/** Kinds that describe the site plan rather than rooms inside the house. */
export const SITE_KINDS: ReadonlySet<string> = new Set(["LOT", "FOOTPRINT", "YARD", "HARDSCAPE"]);

/** Square yards — how sod and some flooring are sold. */
export function squareYards(points: Point[]): number {
  return polygonArea(points) / 9;
}

export interface ImportRoom {
  name: string;
  kind: RoomKind;
  parent: string | null;
  points: Point[];
  /** Where the name is drawn; defaults to the outline's center. */
  label: Point | null;
  haArea: string | null;
  notes: string | null;
}

export interface ImportFloor {
  name: string;
  level: number;
  rooms: ImportRoom[];
}

/** Validate and normalize an import document. Throws with every problem found. */
export function parseFloorplanImport(doc: unknown): ImportFloor[] {
  const errors: string[] = [];
  const d = doc as { floors?: unknown };
  if (!d || typeof d !== "object" || !Array.isArray(d.floors)) {
    throw new Error('Expected an object with a "floors" array');
  }
  const out: ImportFloor[] = [];
  d.floors.forEach((f: any, fi: number) => {
    const where = `floors[${fi}]`;
    if (!f?.name || typeof f.name !== "string") errors.push(`${where}: name is required`);
    const level = Number.isInteger(f?.level) ? f.level : fi + 1;
    const rooms: ImportRoom[] = [];
    const names = new Set<string>();
    (Array.isArray(f?.rooms) ? f.rooms : []).forEach((r: any, ri: number) => {
      const rw = `${f?.name ?? where} → rooms[${ri}]${r?.name ? ` (${r.name})` : ""}`;
      if (!r?.name || typeof r.name !== "string") {
        errors.push(`${rw}: name is required`);
        return;
      }
      if (names.has(r.name.toLowerCase())) errors.push(`${rw}: duplicate room name on this floor`);
      names.add(r.name.toLowerCase());
      const kind = String(r.kind ?? "ROOM").toUpperCase();
      if (!(ROOM_KINDS as readonly string[]).includes(kind)) errors.push(`${rw}: unknown kind "${r.kind}"`);

      let points: Point[] = [];
      if (Array.isArray(r.points)) {
        points = r.points.map((p: any) =>
          Array.isArray(p) ? { x: parseFeetInches(p[0]) ?? NaN, y: parseFeetInches(p[1]) ?? NaN } : { x: NaN, y: NaN },
        );
      } else if (r.rect) {
        const x = parseFeetInches(r.rect.x);
        const y = parseFeetInches(r.rect.y);
        const w = parseFeetInches(r.rect.width);
        const h = parseFeetInches(r.rect.depth);
        if ([x, y, w, h].some((v) => v == null)) errors.push(`${rw}: rect needs x, y, width, depth`);
        else points = rectPoints(x!, y!, w!, h!);
      } else {
        errors.push(`${rw}: give "points" or "rect"`);
      }
      if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
        errors.push(`${rw}: a point isn't a valid length`);
      } else if (points.length > 0 && points.length < 3) {
        errors.push(`${rw}: an outline needs at least 3 points`);
      }
      let label: Point | null = null;
      if (Array.isArray(r.label)) {
        const lx = parseFeetInches(r.label[0]);
        const ly = parseFeetInches(r.label[1]);
        if (lx == null || ly == null) errors.push(`${rw}: label must be [x, y]`);
        else label = { x: lx, y: ly };
      }
      rooms.push({
        name: r.name,
        kind: kind as RoomKind,
        parent: r.parent ?? null,
        points,
        label,
        haArea: r.haArea ?? null,
        notes: r.notes ?? null,
      });
    });
    for (const r of rooms) {
      if (r.parent && !names.has(r.parent.toLowerCase())) {
        errors.push(`${f?.name ?? where} → ${r.name}: parent "${r.parent}" isn't a room on this floor`);
      }
    }
    out.push({ name: f?.name, level, rooms });
  });
  if (errors.length) throw new Error(errors.join("\n"));
  return out;
}

export interface ExportRoomRow {
  name: string;
  kind?: string | null;
  parentName?: string | null;
  points: Point[];
  label?: Point | null;
  haArea?: string | null;
  notes?: string | null;
}

/** The inverse of parseFloorplanImport — for backups and round-tripping. */
export function buildFloorplanExport(
  floors: { name: string; level: number; rooms: ExportRoomRow[] }[],
): string {
  return JSON.stringify(
    {
      version: 1,
      floors: floors.map((f) => ({
        name: f.name,
        level: f.level,
        rooms: f.rooms.map((r) => ({
          name: r.name,
          kind: r.kind ?? "ROOM",
          ...(r.parentName ? { parent: r.parentName } : {}),
          points: r.points.map((p) => [r2(p.x), r2(p.y)]),
          ...(r.label ? { label: [r2(r.label.x), r2(r.label.y)] } : {}),
          ...(r.haArea ? { haArea: r.haArea } : {}),
          ...(r.notes ? { notes: r.notes } : {}),
        })),
      })),
    },
    null,
    2,
  );
}

// ── Room names ───────────────────────────────────────────────────────────────

export interface RoomRef {
  id: string;
  name: string;
  parentRoomId?: string | null;
  floorId?: string | null;
}

/** "Primary bedroom › Closet" for a closet under a room, else the room name. */
export function roomLabel(room: RoomRef, byId: Map<string, RoomRef>): string {
  const parent = room.parentRoomId ? byId.get(room.parentRoomId) : undefined;
  return parent ? `${parent.name} › ${room.name}` : room.name;
}

/** A room and everything nested under it (closets in a bedroom, …). */
export function roomAndDescendants(roomId: string, rooms: RoomRef[]): Set<string> {
  const out = new Set([roomId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rooms) {
      if (r.parentRoomId && out.has(r.parentRoomId) && !out.has(r.id)) {
        out.add(r.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Find a room by what someone called it: exact name, then "parent › name"
 * / "parent name" forms ("primary bedroom closet"), then substring.
 */
export function matchRoom<R extends RoomRef>(rooms: R[], query: string): R | null {
  const q = query.toLowerCase().replace(/[›>]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return null;
  const byId = new Map(rooms.map((r) => [r.id, r as RoomRef]));
  const full = (r: R) => roomLabel(r, byId).toLowerCase().replace(/›/g, " ").replace(/\s+/g, " ").trim();
  return (
    rooms.find((r) => r.name.toLowerCase() === q) ??
    rooms.find((r) => full(r) === q) ??
    rooms.find((r) => full(r).includes(q)) ??
    rooms.find((r) => q.includes(r.name.toLowerCase())) ??
    null
  );
}
