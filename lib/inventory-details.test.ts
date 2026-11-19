import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DETAIL_SPECS, DETAIL_TYPES, detailSummary, formatDetailValue, isPrivateDetailType, pickDetailFields } from "./inventory-details";

describe("inventory detail specs", () => {
  const schema = readFileSync(new URL("../amplify/data/resource.ts", import.meta.url), "utf8");

  it("every type has its model in the schema, with every spec field, and is in the detailType enum", () => {
    for (const t of DETAIL_TYPES) {
      const spec = DETAIL_SPECS[t];
      const at = schema.indexOf(`    ${spec.model}: a`);
      expect(at, spec.model).toBeGreaterThan(0);
      const body = schema.slice(at, schema.indexOf(".authorization", at));
      for (const f of spec.fields) expect(body, `${spec.model}.${f.key}`).toContain(`${f.key}: a.`);
      expect(schema).toMatch(new RegExp(`detailType: a\\.enum\\(\\[[^\\]]*"${t}"`));
    }
  });

  it("private types are owner-only in the schema", () => {
    for (const t of DETAIL_TYPES.filter(isPrivateDetailType)) {
      const at = schema.indexOf(`    ${DETAIL_SPECS[t].model}: a`);
      const auth = schema.indexOf(".authorization", at);
      expect(schema.slice(auth, auth + 25)).toBe(".authorization(ownerOnly)");
    }
    expect(isPrivateDetailType("FIREARM")).toBe(true);
    expect(isPrivateDetailType("FILAMENT")).toBe(false);
  });

  it("summarizes a row in one line", () => {
    expect(detailSummary("AMMO", { caliber: "9mm", grain: 115, bulletType: "FMJ", roundsAvailable: 850 })).toBe("9mm · 115gr · FMJ · 850 rds");
    expect(detailSummary("PHOTOGRAPHY", { type: "LENS", mount: "E", focalLengthMin: 24, focalLengthMax: 70, apertureMax: 2.8 })).toBe("Lens · E · 24-70mm · f/2.8");
    expect(detailSummary("FILAMENT", { material: "PLA_CF", color: "Black" }, { quantity: 3 })).toBe("PLA CF · Black · 3 spools");
    expect(detailSummary("FIREARM", null)).toBe("");
  });

  it("picks only spec fields and formats values", () => {
    expect(pickDetailFields("FIREARM", { id: "x", itemId: "i", caliber: "9mm", serialNumber: "", junk: 1 })).toEqual({
      type: null, caliber: "9mm", serialNumber: null, action: null, barrelLength: null, finish: null,
    });
    const f = DETAIL_SPECS.PHOTOGRAPHY.fields;
    expect(formatDetailValue(f.find((x) => x.key === "stabilized")!, true)).toBe("Yes");
    expect(formatDetailValue(f.find((x) => x.key === "weightG")!, 500)).toBe("500 g");
    expect(formatDetailValue(DETAIL_SPECS.ELECTRONIC.fields[0], "WIRE_CONNECTOR")).toBe("Wire / connector");
  });
});
