import { describe, expect, it } from "vitest";
import { depreciatedValue, isStale, marketcheckValue, refreshAssetValues, rentcastValue, type FetchLike } from "./asset-values";

/* eslint-disable @typescript-eslint/no-explicit-any */

const fakeFetch =
  (routes: Record<string, { status?: number; body: any }>): FetchLike & { calls: string[] } => {
    const f: any = async (url: string) => {
      f.calls.push(url);
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      if (!hit) return { ok: false, status: 404, json: async () => ({}), text: async () => "no route" };
      const { status = 200, body } = hit[1];
      return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
    };
    f.calls = [];
    return f;
  };

describe("providers", () => {
  it("reads RentCast's estimate and range, sending the key in the header", async () => {
    const fetchFn = fakeFetch({ "api.rentcast.io/v1/avm/value": { body: { price: 512000, priceRangeLow: 480000, priceRangeHigh: 540000 } } });
    const r = await rentcastValue("1 Main St, Round Rock, TX 78665", "key", fetchFn);
    expect(r).toEqual({ value: 512000, note: "Auto: RentCast $512,000 (range $480,000–$540,000)" });
    expect(fetchFn.calls[0]).toContain("address=1%20Main%20St%2C%20Round%20Rock%2C%20TX%2078665");
    await expect(rentcastValue("1 Main St", "", fetchFn)).rejects.toThrow(/RENTCAST_API_KEY/);
    await expect(rentcastValue("x", "key", fakeFetch({ "avm/value": { status: 401, body: { error: "auth/api-key-invalid" } } }))).rejects.toThrow(/RentCast 401/);
  });

  it("reads MarketCheck's predicted price by VIN, mileage and ZIP", async () => {
    const fetchFn = fakeFetch({ "predict/car/us/marketcheck_price": { body: { marketcheck_price: 58750.4, msrp: 101000 } } });
    const r = await marketcheckValue({ vin: "wba13bk0xpcm12345", miles: 24100, zip: "78665" }, "key", fetchFn);
    expect(r).toEqual({ value: 58750.4, note: "Auto: MarketCheck $58,750 at 24,100 mi (MSRP $101,000)" });
    expect(fetchFn.calls[0]).toContain("vin=WBA13BK0XPCM12345");
    expect(fetchFn.calls[0]).toContain("dealer_type=independent");
    await expect(marketcheckValue({ vin: "short", miles: 1, zip: "78665" }, "key", fetchFn)).rejects.toThrow(/17-character VIN/);
    await expect(marketcheckValue({ vin: "WBA13BK0XPCM12345", miles: 0, zip: "78665" }, "key", fetchFn)).rejects.toThrow(/mileage/);
  });

  it("depreciates the purchase price by the day", () => {
    // A year (365 of 365.25 days) at 15%: a hair above 85,000.
    expect(depreciatedValue(100000, "2023-01-01", 0.15, "2024-01-01").value).toBeCloseTo(85000, -2);
    expect(depreciatedValue(100000, "2023-01-01", 0.15, "2025-01-01").value).toBeCloseTo(72250, -2);
    expect(depreciatedValue(100000, "2023-01-01", 0.15, "2022-06-01").value).toBe(100000);
    expect(() => depreciatedValue(0, "2023-01-01", 0.15, "2024-01-01")).toThrow();
  });
});

describe("refreshAssetValues", () => {
  const setup = () => {
    const tables: Record<string, any[]> = { homeFinanceAsset: [], homeFinanceAssetValuation: [] };
    let n = 0;
    const model = (name: string) => ({
      create: async (row: any) => {
        const saved = { id: `${name}-${++n}`, ...row };
        tables[name].push(saved);
        return { data: saved };
      },
      update: async ({ id, ...patch }: any) => {
        const row = tables[name].find((r) => r.id === id);
        Object.assign(row, patch);
        return { data: row };
      },
    });
    return { tables, client: { models: { homeFinanceAsset: model("homeFinanceAsset"), homeFinanceAssetValuation: model("homeFinanceAssetValuation") } } };
  };
  const house = { id: "h", name: "Home", type: "REAL_ESTATE", valueProvider: "RENTCAST" as const, address: "1 Main St, Round Rock, TX 78665", currentValue: 500000, valuedOn: "2026-10-01" };
  const car = { id: "c", name: "BMW", type: "VEHICLE", valueProvider: "DEPRECIATION" as const, purchaseValue: 110000, purchaseDate: "2022-12-17", currentValue: 60000, valuedOn: "2026-10-01" };
  const fetchFn = fakeFetch({ "avm/value": { body: { price: 515000, priceRangeLow: 490000, priceRangeHigh: 540000 } } });

  it("writes today's estimate for each asset with a provider and mirrors it onto the asset", async () => {
    const { tables, client } = setup();
    tables.homeFinanceAsset.push({ ...house }, { ...car }, { id: "x", name: "Watch", currentValue: 5000 });
    const r = await refreshAssetValues({ client, assets: tables.homeFinanceAsset, valuations: [], onlyStale: true, today: "2026-11-16", keys: { rentcast: "key" }, fetchFn });
    expect(r.map((x) => [x.name, x.value, x.change, x.error])).toEqual([
      ["Home", 515000, 15000, null],
      ["BMW", expect.any(Number), expect.any(Number), null],
    ]);
    expect(tables.homeFinanceAssetValuation).toHaveLength(2);
    expect(tables.homeFinanceAssetValuation[0]).toMatchObject({ assetId: "h", date: "2026-11-16", value: 515000, source: "ESTIMATE", notes: expect.stringMatching(/^Auto: RentCast/) });
    expect(tables.homeFinanceAsset[0]).toMatchObject({ currentValue: 515000, valuedOn: "2026-11-16" });
    expect(r[1].value).toBeLessThan(60000);
  });

  it("skips assets refreshed recently on the scheduled run, replaces a same-day estimate, and keeps going past a failure", async () => {
    const { tables, client } = setup();
    tables.homeFinanceAsset.push({ ...house }, { ...car, valueProvider: "MARKETCHECK" as const, vin: "" });
    tables.homeFinanceAssetValuation.push({ id: "v1", assetId: "h", date: "2026-11-01", value: 510000, source: "ESTIMATE", notes: "Auto: RentCast $510,000" }, { id: "v2", assetId: "h", date: "2026-11-16", value: 1, source: "ESTIMATE", notes: "typo" });
    expect(isStale(house, tables.homeFinanceAssetValuation, "2026-11-16")).toBe(false);
    const scheduled = await refreshAssetValues({ client, assets: tables.homeFinanceAsset, valuations: tables.homeFinanceAssetValuation, onlyStale: true, today: "2026-11-16", keys: { rentcast: "key", marketcheck: "k" }, fetchFn });
    expect(scheduled[0]).toMatchObject({ name: "Home", skipped: true });
    expect(scheduled[1]).toMatchObject({ name: "BMW", error: expect.stringMatching(/VIN/) });

    const manual = await refreshAssetValues({ client, assets: tables.homeFinanceAsset, valuations: tables.homeFinanceAssetValuation, assetIds: ["h"], onlyStale: false, today: "2026-11-16", keys: { rentcast: "key" }, fetchFn });
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ value: 515000, skipped: false });
    // The same-day row was corrected, not duplicated.
    expect(tables.homeFinanceAssetValuation.filter((v) => v.date === "2026-11-16")).toHaveLength(1);
    expect(tables.homeFinanceAssetValuation.find((v) => v.id === "v2")).toMatchObject({ value: 515000 });
  });

  it("doesn't overwrite a value typed in for a later date", async () => {
    const { tables, client } = setup();
    tables.homeFinanceAsset.push({ ...house, currentValue: 530000, valuedOn: "2026-11-20" });
    await refreshAssetValues({ client, assets: tables.homeFinanceAsset, valuations: [], onlyStale: false, today: "2026-11-16", keys: { rentcast: "key" }, fetchFn });
    expect(tables.homeFinanceAsset[0]).toMatchObject({ currentValue: 530000, valuedOn: "2026-11-20" });
    expect(tables.homeFinanceAssetValuation).toHaveLength(1);
  });
});
