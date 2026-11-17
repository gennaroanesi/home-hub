import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TX_FIELDS } from "./data";

// Transactions are read with hand-written GraphQL (txIndexQuery), so a field
// added to the model but not to TX_FIELDS is saved and then never read back
// (that's how `ledger` changes looked unsaved).
describe("TX_FIELDS", () => {
  it("selects every field of homeFinanceTransaction", () => {
    const schema = readFileSync(new URL("../../amplify/data/resource.ts", import.meta.url), "utf8");
    const block = schema.slice(schema.indexOf("homeFinanceTransaction: a"), schema.indexOf("homeFinanceRecurring: a"));
    const fields = [...block.matchAll(/^\s{8}(\w+): a\.(?!belongsTo|hasMany)/gm)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(10);
    const selected = new Set(TX_FIELDS.split(/\s+/).filter(Boolean));
    expect(fields.filter((f) => !selected.has(f))).toEqual([]);
  });
});
