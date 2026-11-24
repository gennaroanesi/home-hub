import { describe, expect, it } from "vitest";

import { inboxDraftValues, inboxToReview, paycheckFormProblem, paycheckFormState, paycheckRow, paycheckSanityGap, sharePct, supplementalOf } from "./paycheck-screen";

describe("paycheck form", () => {
  it("builds the form from a saved row and writes it back", () => {
    const f = paycheckFormState({ payDate: "2026-11-14", gross: 5000, net: 3500, fedWh: 900, lineItems: JSON.stringify([{ name: "ESPP", amount: 600, type: "POSTTAX" }, { name: "x", type: "WEIRD" }]) }, "p1");
    expect(f.personId).toBe("p1");
    expect(f.nums.gross).toBe("5000");
    expect(f.items.map((i) => i.type)).toEqual(["POSTTAX", "OTHER"]);
    expect(paycheckFormProblem(f)).toBeNull();
    const row = paycheckRow({ ...f, employer: "  ", items: [...f.items, { name: "", amount: "", ytd: "", type: "PRETAX" }] });
    expect(row.gross).toBe(5000);
    expect(row.stateWh).toBeNull();
    expect(row.employer).toBeNull();
    expect(JSON.parse(row.lineItems as string)).toEqual([
      { name: "ESPP", amount: 600, ytd: null, type: "POSTTAX" },
      { name: "x", amount: 0, ytd: null, type: "OTHER" },
    ]);
  });

  it("checks gross against its parts", () => {
    const f = paycheckFormState({ gross: 5000, net: 3500, fedWh: 900 });
    expect(paycheckSanityGap(f)).toBe(600);
    expect(paycheckSanityGap({ ...f, items: [{ name: "ESPP", amount: "600", ytd: "", type: "POSTTAX" }] })).toBeNull();
  });

  it("says what's missing", () => {
    expect(paycheckFormProblem(paycheckFormState({}, null))).toMatch(/whose/);
    expect(paycheckFormProblem(paycheckFormState({}, "p"))).toMatch(/Pay date/);
    expect(paycheckFormProblem(paycheckFormState({ payDate: "2026-01-02", gross: 1 }, "p"))).toMatch(/Gross and net/);
  });
});

describe("paycheck inbox", () => {
  it("keeps rows to review, newest first", () => {
    const rows = [
      { id: "1", status: "IMPORTED", receivedAt: "2026-11-03" },
      { id: "2", status: "NEEDS_REVIEW", receivedAt: "2026-11-01" },
      { id: "3", status: "ERROR", receivedAt: "2026-11-02" },
    ];
    expect(inboxToReview(rows).map((r) => r.id)).toEqual(["3", "2"]);
  });

  it("reads a stringified draft", () => {
    expect(inboxDraftValues({ draft: JSON.stringify(JSON.stringify({ payDate: "2026-11-14", net: 10, junk: 1 })) })).toEqual({ payDate: "2026-11-14", net: 10 });
  });

  it("formats", () => {
    expect(supplementalOf({ bonusGross: 100, rsuGross: 0 })).toEqual({ amount: 100, label: "bonus" });
    expect(supplementalOf({ rsuGross: 50 })).toEqual({ amount: 50, label: "RSU" });
    expect(supplementalOf({})).toBeNull();
    expect(sharePct(0.426)).toBe("43%");
    expect(sharePct(null)).toBe("—");
  });
});
