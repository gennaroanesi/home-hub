import { describe, expect, it } from "vitest";

import {
  buildFloorSvg,
  buildFloorplanExport,
  centroid,
  describeSize,
  formatFeetInches,
  parseFeetInches,
  parseFloorplanImport,
  polygonArea,
  rectPoints,
  matchRoom,
  roomAndDescendants,
  roomLabel,
  fitViewBox,
  formatViewBox,
  parseViewBox,
  zoomViewBox,
} from "./floorplan";

describe("parseFeetInches", () => {
  it.each([
    ["12", 12],
    ["12.5", 12.5],
    ["12'6\"", 12.5],
    ["12' 6\"", 12.5],
    ["12′ 6″", 12.5],
    ["12 ft 6 in", 12.5],
    ["12ft6in", 12.5],
    ["12'6", 12.5],
    ["12-6", 12.5],
    ["12'", 12],
    ["150\"", 12.5],
    ["150 in", 12.5],
  ])("%s → %s", (input, feet) => {
    expect(parseFeetInches(input)).toBeCloseTo(feet, 6);
  });

  it("rejects junk and 12+ inches", () => {
    expect(parseFeetInches("big")).toBeNull();
    expect(parseFeetInches("10'13\"")).toBeNull();
    expect(parseFeetInches("")).toBeNull();
  });
});

describe("formatFeetInches", () => {
  it("rounds to the inch", () => {
    expect(formatFeetInches(12.5)).toBe("12′ 6″");
    expect(formatFeetInches(10)).toBe("10′");
    expect(formatFeetInches(9.99)).toBe("10′");
  });
});

describe("geometry", () => {
  const l = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 4 },
    { x: 4, y: 4 },
    { x: 4, y: 10 },
    { x: 0, y: 10 },
  ];

  it("measures rectangles and L-shapes", () => {
    expect(polygonArea(rectPoints(0, 0, 12.5, 10))).toBe(125);
    expect(polygonArea(l)).toBe(64);
    expect(describeSize(rectPoints(3, 2, 12.5, 10))).toBe("12′ 6″ × 10′");
    expect(describeSize(l)).toBe("64 sq ft");
  });

  it("finds the center of mass", () => {
    const c = centroid(rectPoints(0, 0, 10, 4));
    expect(c.x).toBeCloseTo(5);
    expect(c.y).toBeCloseTo(2);
  });
});

describe("buildFloorSvg", () => {
  it("draws each room to scale with a clickable group", () => {
    const svg = buildFloorSvg(
      [
        { id: "a", name: "Kitchen & dining", kind: "KITCHEN", points: rectPoints(0, 0, 20, 12) },
        { id: "b", name: "Pantry", kind: "CLOSET", points: rectPoints(20, 0, 4, 5) },
      ],
      { selectedRoomId: "b", badges: { a: 3 } },
    );
    expect(svg).toContain('viewBox="-2 -2 28 18"');
    expect(svg).toContain('data-room-id="a"');
    expect(svg).toContain('class="room kind-closet selected"');
    expect(svg).toContain("Kitchen &amp; dining");
    expect(svg).toContain("20′ × 12′");
    expect(svg).toContain("10 ft");
  });
});

describe("import / export", () => {
  it("accepts points or feet-and-inches rects and round-trips", () => {
    const floors = parseFloorplanImport({
      version: 1,
      floors: [
        {
          name: "Second floor",
          level: 2,
          rooms: [
            { name: "Primary bedroom", kind: "bedroom", points: [[0, 0], [14, 0], [14, "12'6\""], [0, "12'6\""]] },
            { name: "Primary closet", kind: "CLOSET", parent: "Primary bedroom", rect: { x: 14, y: 0, width: "6'", depth: "5'6\"" } },
          ],
        },
      ],
    });
    expect(floors[0].rooms[0].kind).toBe("BEDROOM");
    expect(floors[0].rooms[0].points[2]).toEqual({ x: 14, y: 12.5 });
    expect(floors[0].rooms[1].points).toEqual(rectPoints(14, 0, 6, 5.5));

    const json = buildFloorplanExport([
      {
        name: "Second floor",
        level: 2,
        rooms: floors[0].rooms.map((r) => ({ ...r, parentName: r.parent })),
      },
    ]);
    expect(parseFloorplanImport(JSON.parse(json))).toEqual(floors);
  });

  it("reports every problem at once", () => {
    expect(() =>
      parseFloorplanImport({
        floors: [
          {
            name: "First floor",
            rooms: [
              { name: "Den", kind: "CAVE", points: [[0, 0], [1, 1]] },
              { name: "Closet", parent: "Nope", rect: { x: 0, y: 0, width: "3'" } },
            ],
          },
        ],
      }),
    ).toThrow(/unknown kind "CAVE"[\s\S]*at least 3 points[\s\S]*rect needs[\s\S]*parent "Nope"/);
  });
});

describe("room names", () => {
  const rooms = [
    { id: "br", name: "Primary bedroom" },
    { id: "cl", name: "Closet", parentRoomId: "br" },
    { id: "sh", name: "Shoe shelf", parentRoomId: "cl" },
    { id: "gar", name: "Garage" },
  ];
  const byId = new Map(rooms.map((r) => [r.id, r]));

  it("labels nested rooms with their parent", () => {
    expect(roomLabel(rooms[1], byId)).toBe("Primary bedroom › Closet");
    expect(Array.from(roomAndDescendants("br", rooms)).sort()).toEqual(["br", "cl", "sh"]);
  });

  it("matches what people call a room", () => {
    expect(matchRoom(rooms, "garage")?.id).toBe("gar");
    expect(matchRoom(rooms, "primary bedroom closet")?.id).toBe("cl");
    expect(matchRoom(rooms, "Primary bedroom › Closet")?.id).toBe("cl");
    expect(matchRoom(rooms, "in the garage by the door")?.id).toBe("gar");
    expect(matchRoom(rooms, "attic")).toBeNull();
  });
});

describe("zoom math", () => {
  const full = { x: -2, y: -2, w: 40, h: 60 };

  it("parses and formats viewBoxes", () => {
    expect(parseViewBox("-2 -2 40 60")).toEqual(full);
    expect(parseViewBox("1 2 0 3")).toBeNull();
    expect(formatViewBox({ x: 1.23456, y: 0, w: 10, h: 5 })).toBe("1.235 0 10 5");
  });

  it("zooms around a fixed point and clamps", () => {
    const z = zoomViewBox(full, 2, { x: 18, y: 28 }, full);
    expect(z.w).toBe(20);
    expect(z.h).toBe(30);
    expect(z.x).toBe(8); // 18 - (18 - -2) / 2
    expect(z.y).toBe(13);
    // Zooming out past the full view snaps back to it.
    expect(zoomViewBox(z, 0.1, { x: 0, y: 0 }, full)).toEqual(full);
    // Max zoom.
    expect(zoomViewBox(full, 1000, { x: 18, y: 28 }, full).w).toBeCloseTo(40 / 12);
  });

  it("frames a room in the drawing's aspect ratio", () => {
    const v = fitViewBox(rectPoints(20, 30, 10, 8), full);
    expect(v.w / v.h).toBeCloseTo(40 / 60);
    expect(v.x).toBeLessThan(20);
    expect(v.x + v.w).toBeGreaterThan(30);
    expect(v.y).toBeLessThan(30);
    expect(v.y + v.h).toBeGreaterThan(38);
    // A tiny closet still gets at least minSize feet of context.
    expect(fitViewBox(rectPoints(5, 5, 2, 2), full).w).toBeGreaterThanOrEqual(12);
  });
});
