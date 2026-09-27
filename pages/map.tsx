"use client";

// House map. Floors and rooms drawn to scale from their outlines in feet
// (lib/floorplan.ts builds the SVG — the same markup is what "Export SVG"
// downloads). Click a room to see what's stored there; closets roll up
// into the room they open off. Geometry usually arrives as an import
// file traced from the floor plans; rooms can also be added / fixed here.

import React, { useEffect, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Spinner, addToast } from "@heroui/react";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/modal";
import { FaMap, FaPlus, FaPen, FaFileImport, FaDownload } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { FloorMap } from "@/components/floor-map";
import { listAllPages } from "@/lib/list-all";
import {
  ROOM_KINDS,
  ROOM_KIND_LABELS,
  bounds,
  buildFloorSvg,
  buildFloorplanExport,
  describeSize,
  formatFeetInches,
  isRectangle,
  parseFeetInches,
  parseFloorplanImport,
  polygonArea,
  rectPoints,
  roomAndDescendants,
  roomLabel,
  squareYards,
  type Point,
  type RoomKind,
} from "@/lib/floorplan";
import { INVENTORY_STATUS_LABELS, type InventoryStatus } from "@/lib/inventory";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Floor = Schema["homeFloor"]["type"];
type Room = Schema["homeRoom"]["type"];
type Item = Schema["homeInventoryItem"]["type"];

const roomPoints = (r: Room): Point[] =>
  (r.points ?? []).filter((p): p is Point => !!p && Number.isFinite(p.x) && Number.isFinite(p.y));

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// ── Page ─────────────────────────────────────────────────────────────────

export default function MapPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [floorId, setFloorId] = useState("");
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

  const [roomModalOpen, setRoomModalOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [floorModalOpen, setFloorModalOpen] = useState(false);
  const [editingFloor, setEditingFloor] = useState<Floor | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await getCurrentUser();
      } catch {
        router.push("/login");
        return;
      }
      await loadAll();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAll() {
    try {
      const [fl, rm, it] = await Promise.all([
        listAllPages<Floor>(client.models.homeFloor),
        listAllPages<Room>(client.models.homeRoom),
        listAllPages<Item>(client.models.homeInventoryItem),
      ]);
      const sorted = fl.sort((a, b) => a.level - b.level);
      setFloors(sorted);
      setRooms(rm);
      setItems(it);
      setFloorId((cur) => (cur && sorted.some((f) => f.id === cur) ? cur : sorted[0]?.id ?? ""));
    } catch (err) {
      console.error("Failed to load the map:", err);
      addToast({ title: "Couldn't load the map", color: "danger" });
    } finally {
      setLoading(false);
    }
  }

  const floor = floors.find((f) => f.id === floorId) ?? null;
  const floorRooms = useMemo(() => rooms.filter((r) => r.floorId === floorId), [rooms, floorId]);
  const roomsById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);

  // Items still in the house, counted per room including its closets.
  const liveItems = useMemo(() => items.filter((i) => i.status === "OWNED" || i.status === "WISHLIST"), [items]);
  const badges = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of floorRooms) {
      const ids = roomAndDescendants(r.id, rooms);
      const n = liveItems.filter((i) => i.roomId && ids.has(i.roomId) && i.status === "OWNED").length;
      if (n) out[r.id] = n;
    }
    return out;
  }, [floorRooms, rooms, liveItems]);

  const svg = useMemo(
    () =>
      buildFloorSvg(
        floorRooms.map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          points: roomPoints(r),
          labelX: r.labelX,
          labelY: r.labelY,
        })),
        { selectedRoomId, badges, title: floor?.name },
      ),
    [floorRooms, selectedRoomId, badges, floor?.name],
  );

  const selected = selectedRoomId ? roomsById.get(selectedRoomId) ?? null : null;

  const pointsByRoom = useMemo(() => new Map(floorRooms.map((r) => [r.id, roomPoints(r)])), [floorRooms]);

  function exportSvg() {
    if (!floor) return;
    // Export without selection/badges — a clean plan.
    const clean = buildFloorSvg(
      floorRooms.map((r) => ({ id: r.id, name: r.name, kind: r.kind, points: roomPoints(r), labelX: r.labelX, labelY: r.labelY })),
      { title: floor.name },
    );
    download(`${slug(floor.name)}.svg`, clean, "image/svg+xml");
  }

  function exportJson() {
    const json = buildFloorplanExport(
      floors.map((f) => ({
        name: f.name,
        level: f.level,
        rooms: rooms
          .filter((r) => r.floorId === f.id)
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
          .map((r) => ({
            name: r.name,
            kind: r.kind,
            parentName: r.parentRoomId ? roomsById.get(r.parentRoomId)?.name ?? null : null,
            points: roomPoints(r),
            label: r.labelX != null && r.labelY != null ? { x: r.labelX, y: r.labelY } : null,
            haArea: r.haArea,
            notes: r.notes,
          })),
      })),
    );
    download("house-map.json", json, "application/json");
  }

  return (
    <DefaultLayout>
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-2">
            <FaMap className="text-default-500" />
            <h1 className="text-2xl font-bold">House map</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="flat" startContent={<FaFileImport />} onPress={() => setImportOpen(true)}>
              Import
            </Button>
            {floors.length > 0 && (
              <>
                <Button size="sm" variant="flat" startContent={<FaDownload />} onPress={exportSvg} isDisabled={!floorRooms.length}>
                  SVG
                </Button>
                <Button size="sm" variant="flat" startContent={<FaDownload />} onPress={exportJson}>
                  JSON
                </Button>
              </>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner label="Loading map..." />
          </div>
        ) : floors.length === 0 ? (
          <div className="text-center py-16 text-default-500 space-y-3">
            <p>No floors yet.</p>
            <p className="text-sm text-default-400">
              Import a traced floor plan (JSON), or add a floor and draw rooms by hand.
            </p>
            <div className="flex justify-center gap-2">
              <Button size="sm" color="primary" onPress={() => setImportOpen(true)}>
                Import
              </Button>
              <Button
                size="sm"
                variant="flat"
                onPress={() => {
                  setEditingFloor(null);
                  setFloorModalOpen(true);
                }}
              >
                Add floor
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Floor tabs */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              {floors.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    setFloorId(f.id);
                    setSelectedRoomId(null);
                  }}
                  onDoubleClick={() => {
                    setEditingFloor(f);
                    setFloorModalOpen(true);
                  }}
                  className={`px-3 py-1 rounded-full text-sm ${
                    f.id === floorId ? "bg-primary text-primary-foreground" : "bg-default-100 text-default-600"
                  }`}
                >
                  {f.name}
                </button>
              ))}
              {floor && (
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  aria-label="Edit floor"
                  onPress={() => {
                    setEditingFloor(floor);
                    setFloorModalOpen(true);
                  }}
                >
                  <FaPen size={11} />
                </Button>
              )}
              <Button
                size="sm"
                variant="light"
                startContent={<FaPlus size={10} />}
                onPress={() => {
                  setEditingFloor(null);
                  setFloorModalOpen(true);
                }}
              >
                Floor
              </Button>
              <div className="ml-auto">
                <Button
                  size="sm"
                  variant="flat"
                  startContent={<FaPlus size={10} />}
                  onPress={() => {
                    setEditingRoom(null);
                    setRoomModalOpen(true);
                  }}
                >
                  Room
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 items-start">
              <div className="border border-default-200 rounded-md bg-content1 p-2 min-h-[240px] overflow-hidden">
                {floorRooms.length ? (
                  <FloorMap
                    svg={svg}
                    resetKey={floorId}
                    roomPoints={pointsByRoom}
                    selectedRoomId={selectedRoomId}
                    onSelect={setSelectedRoomId}
                  />
                ) : (
                  <p className="text-sm text-default-400 p-6">No rooms on this floor yet — add one or import.</p>
                )}
                <p className="text-[11px] text-default-400 px-1 pt-1">
                  Click a room to zoom to it · drag to pan · pinch or ⌘/Ctrl + scroll to zoom
                </p>
              </div>

              <RoomPanel
                room={selected}
                rooms={rooms}
                roomsById={roomsById}
                items={liveItems}
                onEdit={() => {
                  setEditingRoom(selected);
                  setRoomModalOpen(true);
                }}
                onSelect={setSelectedRoomId}
              />
            </div>
          </>
        )}
      </div>

      {floor && (
        <RoomModal
          isOpen={roomModalOpen}
          onOpenChange={setRoomModalOpen}
          editing={editingRoom}
          floor={floor}
          floorRooms={floorRooms}
          items={items}
          onSaved={(id) => {
            if (id !== undefined) setSelectedRoomId(id);
            void loadAll();
          }}
        />
      )}
      <FloorModal
        isOpen={floorModalOpen}
        onOpenChange={setFloorModalOpen}
        editing={editingFloor}
        roomCount={editingFloor ? rooms.filter((r) => r.floorId === editingFloor.id).length : 0}
        nextLevel={(floors[floors.length - 1]?.level ?? 0) + 1}
        onSaved={(id) => {
          if (id) setFloorId(id);
          void loadAll();
        }}
      />
      <ImportModal isOpen={importOpen} onOpenChange={setImportOpen} floors={floors} rooms={rooms} onImported={loadAll} />
    </DefaultLayout>
  );
}

// ── Selected room panel ──────────────────────────────────────────────────

function RoomPanel({
  room,
  rooms,
  roomsById,
  items,
  onEdit,
  onSelect,
}: {
  room: Room | null;
  rooms: Room[];
  roomsById: Map<string, Room>;
  items: Item[];
  onEdit: () => void;
  onSelect: (id: string) => void;
}) {
  if (!room) {
    return (
      <aside className="border border-default-200 rounded-md p-4 text-sm text-default-400">
        Click a room to see what&apos;s stored there.
      </aside>
    );
  }
  const pts = roomPoints(room);
  const ids = roomAndDescendants(room.id, rooms);
  const here = items.filter((i) => i.roomId && ids.has(i.roomId));
  const children = rooms.filter((r) => r.parentRoomId === room.id);
  const parent = room.parentRoomId ? roomsById.get(room.parentRoomId) : undefined;

  return (
    <aside className="border border-default-200 rounded-md p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{room.name}</p>
          <p className="text-xs text-default-500">
            {room.kind ? ROOM_KIND_LABELS[room.kind as RoomKind] : "Room"}
            {pts.length >= 3 && ` · ${describeSize(pts)}`}
            {pts.length >= 3 && isRectangle(pts) && ` · ${Math.round(polygonArea(pts)).toLocaleString()} sq ft`}
            {pts.length >= 3 && room.kind === "YARD" && ` · ≈ ${Math.round(squareYards(pts))} sq yd`}
          </p>
          {parent && (
            <button type="button" className="text-xs text-primary" onClick={() => onSelect(parent.id)}>
              in {parent.name}
            </button>
          )}
        </div>
        <Button isIconOnly size="sm" variant="light" aria-label="Edit room" onPress={onEdit}>
          <FaPen size={11} />
        </Button>
      </div>

      {children.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {children.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              className="text-xs px-2 py-0.5 rounded-full bg-default-100 text-default-600 hover:bg-default-200"
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-medium uppercase tracking-wider text-default-400">Stored here · {here.length}</p>
          <NextLink href={`/inventory?roomId=${room.id}&new=1`} className="text-xs text-primary">
            + Add item
          </NextLink>
        </div>
        {here.length === 0 ? (
          <p className="text-sm text-default-400">Nothing recorded yet.</p>
        ) : (
          <ul className="space-y-1 max-h-[45vh] overflow-y-auto">
            {here
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((i) => (
                <li key={i.id} className="text-sm">
                  <span className="text-foreground">{i.name}</span>
                  {(i.quantity ?? 1) > 1 && <span className="text-default-400"> ×{i.quantity}</span>}
                  {i.status === "WISHLIST" && (
                    <span className="text-[10px] ml-1 text-default-400">({INVENTORY_STATUS_LABELS[i.status as InventoryStatus]})</span>
                  )}
                  {(i.roomId !== room.id || i.location) && (
                    <span className="block text-xs text-default-400">
                      {[i.roomId !== room.id ? roomsById.get(i.roomId!)?.name : null, i.location].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        )}
        <NextLink href={`/inventory?roomId=${room.id}`} className="text-xs text-primary block mt-2">
          Open in inventory →
        </NextLink>
      </div>
      {room.notes && <p className="text-xs text-default-500 whitespace-pre-line">{room.notes}</p>}
    </aside>
  );
}

// ── Room modal ───────────────────────────────────────────────────────────

// Outline text: one "x, y" per line, each in feet or feet-and-inches.
function pointsToText(points: Point[]): string {
  return points.map((p) => `${formatFeetInches(p.x).replace(/ /g, "")}, ${formatFeetInches(p.y).replace(/ /g, "")}`).join("\n");
}

function textToPoints(text: string): Point[] | null {
  const pts: Point[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [xs, ys] = line.split(",").map((s) => s.trim());
    const x = parseFeetInches(xs);
    const y = parseFeetInches(ys);
    if (x == null || y == null) return null;
    pts.push({ x, y });
  }
  return pts.length >= 3 ? pts : null;
}

function RoomModal({
  isOpen,
  onOpenChange,
  editing,
  floor,
  floorRooms,
  items,
  onSaved,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Room | null;
  floor: Floor;
  floorRooms: Room[];
  items: Item[];
  onSaved: (selectId?: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("ROOM");
  const [parentId, setParentId] = useState("");
  const [mode, setMode] = useState<"rect" | "outline">("rect");
  const [x, setX] = useState("0");
  const [y, setY] = useState("0");
  const [width, setWidth] = useState("");
  const [depth, setDepth] = useState("");
  const [outline, setOutline] = useState("");
  const [haArea, setHaArea] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const pts = editing ? roomPoints(editing) : [];
    const rect = pts.length === 0 || isRectangle(pts);
    const b = pts.length ? bounds(pts) : null;
    setName(editing?.name ?? "");
    setKind(editing?.kind ?? "ROOM");
    setParentId(editing?.parentRoomId ?? "");
    setMode(rect ? "rect" : "outline");
    setX(b ? formatFeetInches(b.minX) : "0");
    setY(b ? formatFeetInches(b.minY) : "0");
    setWidth(b ? formatFeetInches(b.width) : "");
    setDepth(b ? formatFeetInches(b.depth) : "");
    setOutline(pts.length ? pointsToText(pts) : "");
    setHaArea(editing?.haArea ?? "");
    setNotes(editing?.notes ?? "");
  }, [isOpen, editing]);

  function currentPoints(): Point[] | null {
    if (mode === "outline") return textToPoints(outline);
    const [px, py, w, d] = [x, y, width, depth].map(parseFeetInches);
    if (px == null || py == null || !w || !d) return null;
    return rectPoints(px, py, w, d);
  }
  const preview = currentPoints();

  async function save(onClose: () => void) {
    const points = currentPoints();
    if (!name.trim()) return;
    if (!points) {
      addToast({
        title: "Check the size",
        description: mode === "rect" ? "Width and depth are required, e.g. 12'6\"." : "Give at least 3 points, one \"x, y\" per line.",
        color: "warning",
      });
      return;
    }
    setSaving(true);
    try {
      const fields = {
        name: name.trim(),
        kind: kind as Room["kind"],
        parentRoomId: parentId || null,
        points,
        haArea: haArea.trim() || null,
        notes: notes.trim() || null,
      };
      const res = editing
        ? await client.models.homeRoom.update({ id: editing.id, ...fields })
        : await client.models.homeRoom.create({ floorId: floor.id, sortOrder: floorRooms.length, ...fields });
      if (res.errors?.length || !res.data) throw new Error(res.errors?.[0]?.message ?? "save failed");
      onClose();
      onSaved(res.data.id);
    } catch (err: any) {
      addToast({ title: "Save failed", description: err?.message ?? String(err), color: "danger" });
    } finally {
      setSaving(false);
    }
  }

  async function remove(onClose: () => void) {
    if (!editing) return;
    const stored = items.filter((i) => i.roomId === editing.id);
    const kids = floorRooms.filter((r) => r.parentRoomId === editing.id);
    const warn = [
      stored.length ? `${stored.length} inventory item(s) will lose their room (their notes stay).` : "",
      kids.length ? `${kids.length} closet(s)/space(s) inside it will stay, unattached.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (!confirm(`Delete ${editing.name}?${warn ? ` ${warn}` : ""}`)) return;
    try {
      for (const i of stored) await client.models.homeInventoryItem.update({ id: i.id, roomId: null });
      for (const k of kids) await client.models.homeRoom.update({ id: k.id, parentRoomId: null });
      const { errors } = await client.models.homeRoom.delete({ id: editing.id });
      if (errors?.length) throw new Error(errors[0].message);
      onClose();
      onSaved(null);
    } catch (err: any) {
      addToast({ title: "Delete failed", description: err?.message ?? String(err), color: "danger" });
    }
  }

  const parentOptions = floorRooms.filter((r) => r.id !== editing?.id);

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg" scrollBehavior="inside">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{editing ? `Edit ${editing.name}` : `New room · ${floor.name}`}</ModalHeader>
            <ModalBody>
              <Input label="Name" value={name} onValueChange={setName} isRequired autoFocus={!editing} />
              <div className="grid grid-cols-2 gap-2">
                <Select label="Kind" selectedKeys={[kind]} onChange={(e) => e.target.value && setKind(e.target.value)}>
                  {ROOM_KINDS.map((k) => (
                    <SelectItem key={k}>{ROOM_KIND_LABELS[k]}</SelectItem>
                  ))}
                </Select>
                <Select
                  label="Inside"
                  placeholder="— (not inside another room)"
                  selectedKeys={parentId ? [parentId] : []}
                  onChange={(e) => setParentId(e.target.value)}
                  description="Closets: the room they open off."
                >
                  {parentOptions.map((r) => (
                    <SelectItem key={r.id}>{r.name}</SelectItem>
                  ))}
                </Select>
              </div>

              <div className="flex gap-2 text-sm">
                {(["rect", "outline"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      if (m === "outline" && mode === "rect" && preview) setOutline(pointsToText(preview));
                      setMode(m);
                    }}
                    className={`px-3 py-1 rounded-full ${mode === m ? "bg-primary text-primary-foreground" : "bg-default-100 text-default-600"}`}
                  >
                    {m === "rect" ? "Rectangle" : "Outline"}
                  </button>
                ))}
              </div>
              {mode === "rect" ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Input label="Width" placeholder={`12'6"`} value={width} onValueChange={setWidth} isRequired />
                  <Input label="Depth" placeholder={`10'`} value={depth} onValueChange={setDepth} isRequired />
                  <Input label="From left" value={x} onValueChange={setX} description="Top-left corner" />
                  <Input label="From top" value={y} onValueChange={setY} />
                </div>
              ) : (
                <Textarea
                  label="Outline"
                  description={`One corner per line: x, y from the floor's top-left, e.g. 14'6", 0. Clockwise.`}
                  value={outline}
                  onValueChange={setOutline}
                  minRows={4}
                  classNames={{ input: "font-mono text-xs" }}
                />
              )}
              <p className="text-xs text-default-500">
                {preview ? `${describeSize(preview)} · ${Math.round(polygonArea(preview))} sq ft` : "Enter the size to see the area."}
              </p>
              <Input
                label="Home Assistant area"
                placeholder="Living Room"
                value={haArea}
                onValueChange={setHaArea}
                description="Optional — lets devices show up in this room later."
              />
              <Textarea label="Notes" value={notes} onValueChange={setNotes} minRows={2} />
            </ModalBody>
            <ModalFooter>
              {editing && (
                <Button variant="light" color="danger" className="mr-auto" onPress={() => remove(onClose)}>
                  Delete
                </Button>
              )}
              <Button variant="light" onPress={onClose}>
                Cancel
              </Button>
              <Button color="primary" isLoading={saving} isDisabled={!name.trim()} onPress={() => save(onClose)}>
                Save
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

// ── Floor modal ──────────────────────────────────────────────────────────

function FloorModal({
  isOpen,
  onOpenChange,
  editing,
  roomCount,
  nextLevel,
  onSaved,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Floor | null;
  roomCount: number;
  nextLevel: number;
  onSaved: (id?: string) => void;
}) {
  const [name, setName] = useState("");
  const [level, setLevel] = useState("1");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName(editing?.name ?? "");
    setLevel(String(editing?.level ?? nextLevel));
  }, [isOpen, editing, nextLevel]);

  async function save(onClose: () => void) {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const fields = { name: name.trim(), level: Math.round(Number(level) || 0) };
      const res = editing
        ? await client.models.homeFloor.update({ id: editing.id, ...fields })
        : await client.models.homeFloor.create(fields);
      if (res.errors?.length || !res.data) throw new Error(res.errors?.[0]?.message ?? "save failed");
      onClose();
      onSaved(res.data.id);
    } catch (err: any) {
      addToast({ title: "Save failed", description: err?.message ?? String(err), color: "danger" });
    } finally {
      setSaving(false);
    }
  }

  async function remove(onClose: () => void) {
    if (!editing) return;
    if (roomCount > 0) {
      addToast({ title: "Delete the rooms on this floor first", color: "warning" });
      return;
    }
    if (!confirm(`Delete ${editing.name}?`)) return;
    const { errors } = await client.models.homeFloor.delete({ id: editing.id });
    if (errors?.length) {
      addToast({ title: "Delete failed", description: errors[0].message, color: "danger" });
      return;
    }
    onClose();
    onSaved();
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="sm">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{editing ? "Edit floor" : "New floor"}</ModalHeader>
            <ModalBody>
              <Input label="Name" placeholder="First floor" value={name} onValueChange={setName} isRequired autoFocus />
              <Input label="Level" type="number" value={level} onValueChange={setLevel} description="Sort order — 0 for the lot / site plan, 1+ for floors." />
            </ModalBody>
            <ModalFooter>
              {editing && (
                <Button variant="light" color="danger" className="mr-auto" onPress={() => remove(onClose)}>
                  Delete
                </Button>
              )}
              <Button variant="light" onPress={onClose}>
                Cancel
              </Button>
              <Button color="primary" isLoading={saving} isDisabled={!name.trim()} onPress={() => save(onClose)}>
                Save
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

// ── Import ───────────────────────────────────────────────────────────────

function ImportModal({
  isOpen,
  onOpenChange,
  floors,
  rooms,
  onImported,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  floors: Floor[];
  rooms: Room[];
  onImported: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setText("");
      setError(null);
    }
  }, [isOpen]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) setText(await f.text());
    e.target.value = "";
  }

  // Upsert: floors by name, rooms by (floor, name) — so re-importing a
  // corrected trace updates geometry in place and keeps inventory links.
  async function run(onClose: () => void) {
    setError(null);
    let parsed;
    try {
      parsed = parseFloorplanImport(JSON.parse(text));
    } catch (err: any) {
      setError(err?.message ?? String(err));
      return;
    }
    setBusy(true);
    let created = 0;
    let updated = 0;
    try {
      for (const f of parsed) {
        let floor = floors.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
        if (!floor) {
          const { data, errors } = await client.models.homeFloor.create({ name: f.name, level: f.level });
          if (errors?.length || !data) throw new Error(errors?.[0]?.message ?? `couldn't create ${f.name}`);
          floor = data;
        } else if (floor.level !== f.level) {
          await client.models.homeFloor.update({ id: floor.id, level: f.level });
        }
        const existing = rooms.filter((r) => r.floorId === floor!.id);
        const idByName = new Map<string, string>();
        for (let i = 0; i < f.rooms.length; i++) {
          const r = f.rooms[i];
          const match = existing.find((x) => x.name.toLowerCase() === r.name.toLowerCase());
          const fields = {
            name: r.name,
            kind: r.kind,
            points: r.points,
            labelX: r.label?.x ?? null,
            labelY: r.label?.y ?? null,
            haArea: r.haArea,
            notes: r.notes,
            sortOrder: i,
          };
          const res = match
            ? await client.models.homeRoom.update({ id: match.id, ...fields })
            : await client.models.homeRoom.create({ floorId: floor.id, ...fields });
          if (res.errors?.length || !res.data) throw new Error(res.errors?.[0]?.message ?? `couldn't save ${r.name}`);
          idByName.set(r.name.toLowerCase(), res.data.id);
          if (match) updated++;
          else created++;
        }
        // Parents after every room on the floor exists.
        for (const r of f.rooms) {
          const id = idByName.get(r.name.toLowerCase())!;
          const parentId = r.parent ? idByName.get(r.parent.toLowerCase()) ?? null : null;
          await client.models.homeRoom.update({ id, parentRoomId: parentId });
        }
      }
      addToast({
        title: "Floor plan imported",
        description: `${created} room${created === 1 ? "" : "s"} added, ${updated} updated.`,
        color: "success",
      });
      onClose();
      onImported();
    } catch (err: any) {
      setError(`Stopped partway: ${err?.message ?? String(err)}. Rooms saved so far are kept — fix and import again.`);
      onImported();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="2xl" scrollBehavior="inside">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>Import floor plan</ModalHeader>
            <ModalBody>
              <p className="text-sm text-default-500">
                A house-map JSON file (from a traced floor plan or an earlier export). Floors match by name and rooms by
                floor + name, so importing again updates shapes without losing what&apos;s stored in each room.
              </p>
              <div>
                <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onFile} />
                <Button size="sm" variant="flat" onPress={() => fileRef.current?.click()}>
                  Choose file…
                </Button>
              </div>
              <Textarea
                label="…or paste JSON"
                value={text}
                onValueChange={setText}
                minRows={8}
                classNames={{ input: "font-mono text-xs" }}
              />
              {error && <pre className="text-xs text-danger whitespace-pre-wrap">{error}</pre>}
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onClose}>
                Cancel
              </Button>
              <Button color="primary" isLoading={busy} isDisabled={!text.trim()} onPress={() => run(onClose)}>
                Import
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
