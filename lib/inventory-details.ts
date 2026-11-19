// What each kind of inventory item records beyond the base fields: one spec
// per detail type, and every surface is generated from it — the web and
// phone item forms, the inventory ops' input/output, Janet's tool text and
// the one-line summary in lists. docs/inventory-specialized.md.
//
// Adding a type: a homeInventory<Type> model keyed by itemId in
// amplify/data/resource.ts, its name in the detailType enum there, and an
// entry here. `private` types (firearms, ammo) are owner-only: their items
// live in homePrivateInventoryItem and their detail models carry only the
// owner rule (see the doc, section 4).

export const DETAIL_TYPES = ["CLOTHING", "CONSUMABLE", "FIREARM", "AMMO", "FILAMENT", "INSTRUMENT", "PHOTOGRAPHY", "ELECTRONIC"] as const;
export type DetailType = (typeof DETAIL_TYPES)[number];

export type DetailFieldKind = "text" | "int" | "float" | "bool" | "date" | "choice" | "shoppingList";

export interface DetailField {
  key: string;
  label: string;
  kind: DetailFieldKind;
  /** choice: the allowed values (stored as is). text: suggestions, anything goes. */
  options?: readonly string[];
  /** Display names for options, when they differ from the stored value. */
  optionLabels?: Record<string, string>;
  unit?: string; // "g", "mm", "fps"
  required?: boolean;
  hint?: string;
}

export interface DetailSpec {
  type: DetailType;
  label: string; // "Firearm"
  /** For the category picker: what the type adds. */
  blurb: string;
  /** Amplify model holding the detail row (keyed by itemId). */
  model: string;
  private: boolean;
  fields: DetailField[];
  /** One line for lists: "9mm · 115gr FMJ · 850 rds". */
  summary: (d: Record<string, unknown>, item?: { quantity?: number | null }) => string;
}

const join = (...parts: Array<string | number | null | undefined | false>) => parts.filter((p) => p !== null && p !== undefined && p !== false && p !== "").join(" · ");
const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const label = (f: DetailField | undefined, v: unknown) => (v == null || v === "" ? null : f?.optionLabels?.[String(v)] ?? String(v));

const FIREARM_TYPES = ["HANDGUN", "RIFLE", "SHOTGUN", "SBR", "SUPPRESSOR", "OTHER"] as const;
const AMMO_UNITS = ["ROUNDS", "BOX", "CASE"] as const;
const FILAMENT_MATERIALS = ["PLA", "PLA_CF", "PETG", "PETG_CF", "ABS", "ASA", "TPU", "NYLON", "PA", "PA_CF", "PA6_GF", "PC", "PVA", "HIPS", "OTHER"] as const;
const INSTRUMENT_TYPES = ["GUITAR", "BASS", "AMPLIFIER", "PEDAL", "KEYBOARD", "OTHER"] as const;
const PHOTO_TYPES = ["CAMERA", "LENS", "DRONE", "GIMBAL", "TRIPOD", "LIGHT", "ACCESSORY", "OTHER"] as const;
const ELECTRONIC_TYPES = ["RESISTOR", "CAPACITOR", "INDUCTOR", "DIODE", "LED", "TRANSISTOR", "IC", "MODULE", "BREADBOARD", "WIRE_CONNECTOR", "TOOL", "CONSUMABLE", "OTHER"] as const;

/** "PLA_CF" → "PLA CF", "WIRE_CONNECTOR" → "Wire / connector". Labels for the upper-case choice values. */
const titled = (values: readonly string[], overrides: Record<string, string> = {}): Record<string, string> =>
  Object.fromEntries(values.map((v) => [v, overrides[v] ?? v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, " ")]));

export const DETAIL_SPECS: Record<DetailType, DetailSpec> = {
  CLOTHING: {
    type: "CLOTHING",
    label: "Clothing",
    blurb: "size, color, type, season",
    model: "homeInventoryClothing",
    private: false,
    fields: [
      { key: "size", label: "Size", kind: "text", hint: "NB, 0-3M, 3T, M…" },
      { key: "color", label: "Color", kind: "text" },
      { key: "type", label: "Type", kind: "text", options: ["Onesie", "Sleeper", "Bodysuit", "Pants", "Shirt", "Sweater", "Jacket", "Dress", "Socks", "Hat", "Shoes"] },
      { key: "season", label: "Season", kind: "choice", options: ["ALL", "WARM", "COLD"], optionLabels: { ALL: "All year", WARM: "Warm", COLD: "Cold" } },
    ],
    summary: (d) => join(str(d.size), str(d.color), str(d.type)),
  },
  CONSUMABLE: {
    type: "CONSUMABLE",
    label: "Consumable",
    blurb: "unit, low stock, expiry",
    model: "homeInventoryConsumable",
    private: false,
    fields: [
      { key: "unit", label: "Unit", kind: "text", options: ["pack", "box", "can", "bottle", "bag", "roll"] },
      { key: "lowStockThreshold", label: "Low at", kind: "int", hint: "At or below this many it goes on the shopping list" },
      { key: "shoppingListId", label: "Shopping list", kind: "shoppingList" },
      { key: "expiresOn", label: "Expires", kind: "date" },
    ],
    summary: (d, item) => join(item?.quantity != null ? `${item.quantity}${str(d.unit) ? ` ${d.unit}` : ""}` : null, str(d.expiresOn) && `exp ${d.expiresOn}`),
  },
  FIREARM: {
    type: "FIREARM",
    label: "Firearm",
    blurb: "type, caliber, serial, action — owner-only",
    model: "homeInventoryFirearm",
    private: true,
    fields: [
      { key: "type", label: "Type", kind: "choice", options: FIREARM_TYPES, optionLabels: titled(FIREARM_TYPES, { SBR: "SBR" }) },
      { key: "caliber", label: "Caliber", kind: "text", hint: "9mm, 5.56 NATO, 12 ga" },
      { key: "serialNumber", label: "Serial number", kind: "text" },
      { key: "action", label: "Action", kind: "text", options: ["Semi-auto", "Bolt", "Lever", "Pump", "Revolver", "Break"] },
      { key: "barrelLength", label: "Barrel length", kind: "text", hint: '16", 4.02"' },
      { key: "finish", label: "Finish", kind: "text" },
    ],
    summary: (d) => join(label(DETAIL_SPECS.FIREARM.fields[0], d.type), str(d.caliber), str(d.action)),
  },
  AMMO: {
    type: "AMMO",
    label: "Ammo",
    blurb: "caliber, load, rounds on hand — owner-only; one item per purchase",
    model: "homeInventoryAmmo",
    private: true,
    fields: [
      { key: "caliber", label: "Caliber", kind: "text", required: true, hint: "Same spelling across purchases: totals and minimums go by caliber" },
      { key: "unit", label: "Bought as", kind: "choice", options: AMMO_UNITS, optionLabels: { ROUNDS: "Rounds", BOX: "Boxes", CASE: "Cases" }, hint: "The item's quantity counts these" },
      { key: "roundsPerUnit", label: "Rounds per box/case", kind: "int" },
      { key: "roundsAvailable", label: "Rounds on hand", kind: "int", hint: "Goes down as you log use" },
      { key: "grain", label: "Grain", kind: "int", unit: "gr" },
      { key: "bulletType", label: "Bullet", kind: "text", options: ["FMJ", "JHP", "SP", "OTM", "Frangible", "Buckshot", "Birdshot", "Slug"] },
      { key: "velocityFps", label: "Velocity", kind: "int", unit: "fps" },
    ],
    summary: (d) => join(str(d.caliber), num(d.grain) != null && `${d.grain}gr`, str(d.bulletType), num(d.roundsAvailable) != null && `${d.roundsAvailable} rds`),
  },
  FILAMENT: {
    type: "FILAMENT",
    label: "3D-printer filament",
    blurb: "material, color, spool weight, diameter",
    model: "homeInventoryFilament",
    private: false,
    fields: [
      { key: "material", label: "Material", kind: "choice", options: FILAMENT_MATERIALS, optionLabels: titled(FILAMENT_MATERIALS, Object.fromEntries(FILAMENT_MATERIALS.map((m) => [m, m.replace("_", " ")])) as Record<string, string>) },
      { key: "variant", label: "Variant", kind: "text", options: ["Basic", "Matte", "Silk", "HF", "Translucent", "Glow", "Marble", "Wood"] },
      { key: "color", label: "Color", kind: "text" },
      { key: "weightG", label: "Spool weight", kind: "int", unit: "g" },
      { key: "diameter", label: "Diameter", kind: "choice", options: ["1.75", "2.85"], optionLabels: { "1.75": "1.75 mm", "2.85": "2.85 mm" } },
    ],
    summary: (d, item) => join(str(d.material)?.replace("_", " "), str(d.variant), str(d.color), item?.quantity != null && item.quantity !== 1 && `${item.quantity} spools`),
  },
  INSTRUMENT: {
    type: "INSTRUMENT",
    label: "Instrument",
    blurb: "type, strings, tuning, finish, serial",
    model: "homeInventoryInstrument",
    private: false,
    fields: [
      { key: "type", label: "Type", kind: "choice", options: INSTRUMENT_TYPES, optionLabels: titled(INSTRUMENT_TYPES) },
      { key: "serialNumber", label: "Serial number", kind: "text" },
      { key: "color", label: "Color", kind: "text" },
      { key: "strings", label: "Strings", kind: "int" },
      { key: "tuning", label: "Tuning", kind: "text", options: ["Standard", "Drop D", "Half step down", "DADGAD", "Open G"] },
      { key: "bodyMaterial", label: "Body", kind: "text", hint: "Alder, mahogany…" },
      { key: "finish", label: "Finish", kind: "text" },
    ],
    summary: (d) => join(label(DETAIL_SPECS.INSTRUMENT.fields[0], d.type), str(d.color), num(d.strings) != null && `${d.strings}-string`, str(d.tuning)),
  },
  PHOTOGRAPHY: {
    type: "PHOTOGRAPHY",
    label: "Photography",
    blurb: "camera / lens / drone specs, serial",
    model: "homeInventoryPhotography",
    private: false,
    fields: [
      { key: "type", label: "Type", kind: "choice", options: PHOTO_TYPES, optionLabels: titled(PHOTO_TYPES) },
      { key: "serialNumber", label: "Serial number", kind: "text" },
      { key: "mount", label: "Mount", kind: "text", options: ["E", "RF", "EF", "L", "Z", "X", "M4/3", "DJI"] },
      { key: "sensorFormat", label: "Sensor", kind: "text", options: ["FF", "APS-C", "M43", '1"', '1/2.3"'] },
      { key: "focalLengthMin", label: "Focal length from", kind: "float", unit: "mm" },
      { key: "focalLengthMax", label: "Focal length to", kind: "float", unit: "mm", hint: "Same as from for a prime" },
      { key: "apertureMax", label: "Max aperture", kind: "float", hint: "f-stop, e.g. 2.8" },
      { key: "stabilized", label: "Stabilized", kind: "bool" },
      { key: "weightG", label: "Weight", kind: "int", unit: "g" },
      { key: "maxFlightTimeMin", label: "Flight time", kind: "int", unit: "min" },
      { key: "subC250g", label: "Under 250 g", kind: "bool", hint: "Drones: under the FAA registration threshold" },
    ],
    summary: (d) => {
      const lo = num(d.focalLengthMin);
      const hi = num(d.focalLengthMax);
      const focal = lo != null ? (hi != null && hi !== lo ? `${lo}-${hi}mm` : `${lo}mm`) : null;
      return join(label(DETAIL_SPECS.PHOTOGRAPHY.fields[0], d.type), str(d.mount), focal, num(d.apertureMax) != null && `f/${d.apertureMax}`);
    },
  },
  ELECTRONIC: {
    type: "ELECTRONIC",
    label: "Electronic part",
    blurb: "component type, part number, value, ratings",
    model: "homeInventoryElectronic",
    private: false,
    fields: [
      { key: "type", label: "Type", kind: "choice", options: ELECTRONIC_TYPES, optionLabels: titled(ELECTRONIC_TYPES, { IC: "IC", LED: "LED", WIRE_CONNECTOR: "Wire / connector" }) },
      { key: "partNumber", label: "Part number", kind: "text", hint: "NE555, 2N3904" },
      { key: "valueText", label: "Value", kind: "text", hint: '10kΩ, 100µF 25V' },
      { key: "packaging", label: "Package", kind: "text", options: ["THT", "DIP-8", "SOIC-8", "SMD-0805", "SMD-0603", "TO-220"] },
      { key: "voltageRating", label: "Voltage", kind: "float", unit: "V" },
      { key: "currentRatingA", label: "Current", kind: "float", unit: "A" },
      { key: "powerRatingW", label: "Power", kind: "float", unit: "W" },
      { key: "tolerancePct", label: "Tolerance", kind: "float", unit: "%" },
      { key: "color", label: "Color", kind: "text" },
    ],
    summary: (d, item) => join(str(d.partNumber), str(d.valueText), str(d.packaging), item?.quantity != null && item.quantity !== 1 && `×${item.quantity}`),
  },
};

export function detailSpec(type: string | null | undefined): DetailSpec | null {
  return type && (DETAIL_TYPES as readonly string[]).includes(type) ? DETAIL_SPECS[type as DetailType] : null;
}

/** Owner-only types: their items live in homePrivateInventoryItem. */
export function isPrivateDetailType(type: string | null | undefined): boolean {
  return !!detailSpec(type)?.private;
}

export function detailSummary(type: string | null | undefined, detail: Record<string, unknown> | null | undefined, item?: { quantity?: number | null }): string {
  const spec = detailSpec(type);
  return spec && detail ? spec.summary(detail, item) : "";
}

/** A detail row's own fields only (no id/itemId/timestamps), empty strings dropped to null. */
export function pickDetailFields(type: DetailType, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of DETAIL_SPECS[type].fields) {
    const v = row[f.key];
    out[f.key] = v === "" || v === undefined ? null : v;
  }
  return out;
}

/** Display a field's value: option labels, units, yes/no. Null when empty. */
export function formatDetailValue(f: DetailField, v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (f.kind === "bool") return v ? "Yes" : "No";
  if (f.kind === "choice") return f.optionLabels?.[String(v)] ?? String(v);
  return f.unit ? `${v} ${f.unit}` : String(v);
}
