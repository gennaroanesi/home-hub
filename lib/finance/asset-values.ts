// Market values for assets, refreshed automatically: the house from
// RentCast's value estimate, a car from MarketCheck's predicted price (by
// VIN + mileage), or a straight depreciation curve when there's no
// provider. Each refresh writes an ESTIMATE valuation ("Auto: …" in its
// notes) so the history and the net worth chart pick it up; a valuation
// typed in by hand on a later date still wins, since currentValue is the
// latest by date.
//
// Pure where it can be: the providers take a fetch function and the
// routine takes the data client, so tests run with fakes. Runs in the
// finance-sync Lambda (monthly on the scheduled sync, and on demand via
// the refreshAssetValues mutation / refresh_asset_values op).

import { daysBetween, round2 } from "./dates";

export const VALUE_PROVIDERS = ["RENTCAST", "MARKETCHECK", "DEPRECIATION"] as const;
export type ValueProvider = (typeof VALUE_PROVIDERS)[number];
export const VALUE_PROVIDER_LABELS: Record<ValueProvider, string> = {
  RENTCAST: "RentCast estimate (real estate, by address)",
  MARKETCHECK: "MarketCheck price (vehicle, by VIN + mileage)",
  DEPRECIATION: "Depreciation curve from the purchase price",
};

/** Auto valuations are recognized by this prefix in their notes. */
export const AUTO_NOTE_PREFIX = "Auto: ";
/** Refresh when the latest auto valuation is at least this old. */
export const REFRESH_AFTER_DAYS = 28;
/** Yearly loss of value when the asset doesn't say (a car). */
export const DEFAULT_ANNUAL_DEPRECIATION = 0.15;

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type ProviderResult = { value: number; note: string };

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

async function readError(res: { status: number; text(): Promise<string> }, who: string): Promise<never> {
  const body = (await res.text().catch(() => "")).slice(0, 200);
  throw new Error(`${who} ${res.status}${body ? `: ${body}` : ""}`);
}

/** RentCast's automated value estimate for a full street address ("Street, City, State, Zip"). */
export async function rentcastValue(address: string, apiKey: string, fetchFn: FetchLike): Promise<ProviderResult> {
  if (!apiKey) throw new Error("RENTCAST_API_KEY isn't set");
  if (!address.trim()) throw new Error("The asset needs its full address (Street, City, State, Zip)");
  const url = `https://api.rentcast.io/v1/avm/value?address=${encodeURIComponent(address.trim())}&compCount=15`;
  const res = await fetchFn(url, { headers: { "X-Api-Key": apiKey, Accept: "application/json" } });
  if (!res.ok) await readError(res, "RentCast");
  const body = await res.json();
  const value = Number(body?.price);
  if (!Number.isFinite(value) || value <= 0) throw new Error("RentCast returned no price");
  const low = Number(body?.priceRangeLow);
  const high = Number(body?.priceRangeHigh);
  const range = Number.isFinite(low) && Number.isFinite(high) ? ` (range ${usd(low)}–${usd(high)})` : "";
  return { value: round2(value), note: `${AUTO_NOTE_PREFIX}RentCast ${usd(value)}${range}` };
}

/** MarketCheck's predicted price for a VIN at a mileage, in a ZIP's market. Independent-dealer pricing: closer to what the car would fetch. */
export async function marketcheckValue(car: { vin: string; miles: number; zip: string }, apiKey: string, fetchFn: FetchLike): Promise<ProviderResult> {
  if (!apiKey) throw new Error("MARKETCHECK_API_KEY isn't set");
  const vin = car.vin.trim().toUpperCase();
  if (vin.length !== 17) throw new Error("The asset needs its 17-character VIN");
  if (!(car.miles > 0)) throw new Error("The asset needs its mileage");
  if (!/^\d{5}$/.test(car.zip.trim())) throw new Error("The asset needs a 5-digit ZIP code");
  const q = new URLSearchParams({ api_key: apiKey, vin, miles: String(Math.round(car.miles)), zip: car.zip.trim(), dealer_type: "independent" });
  const res = await fetchFn(`https://api.marketcheck.com/v2/predict/car/us/marketcheck_price?${q}`, { headers: { Accept: "application/json" } });
  if (!res.ok) await readError(res, "MarketCheck");
  const body = await res.json();
  const value = Number(body?.marketcheck_price);
  if (!Number.isFinite(value) || value <= 0) throw new Error("MarketCheck returned no price for that VIN");
  const msrp = Number(body?.msrp);
  return { value: round2(value), note: `${AUTO_NOTE_PREFIX}MarketCheck ${usd(value)} at ${Math.round(car.miles).toLocaleString("en-US")} mi${Number.isFinite(msrp) && msrp > 0 ? ` (MSRP ${usd(msrp)})` : ""}` };
}

/** Purchase price losing `annualRate` of its value each year, compounded continuously by the day. */
export function depreciatedValue(purchaseValue: number, purchaseDate: string, annualRate: number, today: string): ProviderResult {
  if (!(purchaseValue > 0) || !purchaseDate) throw new Error("The asset needs its purchase price and date");
  const years = Math.max(0, daysBetween(purchaseDate, today)) / 365.25;
  const value = round2(purchaseValue * Math.pow(1 - annualRate, years));
  return { value, note: `${AUTO_NOTE_PREFIX}${Math.round(annualRate * 100)}%/yr depreciation from ${usd(purchaseValue)} (${years.toFixed(1)} yrs)` };
}

export type AssetLike = {
  id: string;
  name: string;
  type?: string | null;
  active?: boolean | null;
  valueProvider?: ValueProvider | null;
  address?: string | null;
  vin?: string | null;
  mileage?: number | null;
  zip?: string | null;
  annualDepreciation?: number | null;
  purchaseValue?: number | null;
  purchaseDate?: string | null;
  currentValue?: number | null;
  valuedOn?: string | null;
};

export type ValuationLike = { id: string; assetId: string; date: string; value: number; source?: string | null; notes?: string | null };

/** The latest auto valuation, if any. */
export function latestAuto(valuations: ValuationLike[], assetId: string): ValuationLike | null {
  return valuations.filter((v) => v.assetId === assetId && (v.notes ?? "").startsWith(AUTO_NOTE_PREFIX)).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}

/** Due for a refresh: no auto valuation yet, or the last one is old enough. */
export function isStale(asset: AssetLike, valuations: ValuationLike[], today: string, after = REFRESH_AFTER_DAYS): boolean {
  const last = latestAuto(valuations, asset.id);
  return !last || daysBetween(last.date, today) >= after;
}

/** Ask the asset's provider for today's value. Throws with a readable reason. */
export async function valueFor(asset: AssetLike, keys: { rentcast?: string; marketcheck?: string }, fetchFn: FetchLike, today: string): Promise<ProviderResult> {
  switch (asset.valueProvider) {
    case "RENTCAST":
      return rentcastValue(asset.address ?? "", keys.rentcast ?? "", fetchFn);
    case "MARKETCHECK":
      return marketcheckValue({ vin: asset.vin ?? "", miles: asset.mileage ?? 0, zip: asset.zip ?? "" }, keys.marketcheck ?? "", fetchFn);
    case "DEPRECIATION":
      return depreciatedValue(asset.purchaseValue ?? 0, asset.purchaseDate ?? "", asset.annualDepreciation ?? DEFAULT_ANNUAL_DEPRECIATION, today);
    default:
      throw new Error("No value provider set");
  }
}

export type AssetRefresh = { assetId: string; name: string; provider: string | null; value: number | null; previous: number | null; change: number | null; skipped: boolean; error: string | null };

/**
 * Refresh every active asset with a provider (or just `assetIds`), writing
 * today's ESTIMATE valuation (one per day: a same-day estimate is replaced)
 * and mirroring it onto the asset when it's the latest. `onlyStale` skips
 * assets refreshed within REFRESH_AFTER_DAYS (the scheduled run); a manual
 * refresh passes false. One asset's failure doesn't stop the others.
 */
export async function refreshAssetValues(args: {
  client: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  assets: AssetLike[];
  valuations: ValuationLike[];
  assetIds?: string[] | null;
  onlyStale: boolean;
  today: string;
  keys: { rentcast?: string; marketcheck?: string };
  fetchFn: FetchLike;
}): Promise<AssetRefresh[]> {
  const M = args.client.models;
  const out: AssetRefresh[] = [];
  const wanted = args.assets.filter((a) => (args.assetIds?.length ? args.assetIds.includes(a.id) : a.active !== false && !!a.valueProvider));
  for (const a of wanted) {
    const base: AssetRefresh = { assetId: a.id, name: a.name, provider: a.valueProvider ?? null, value: null, previous: a.currentValue ?? null, change: null, skipped: false, error: null };
    if (!a.valueProvider) {
      out.push({ ...base, error: "No value provider set" });
      continue;
    }
    if (args.onlyStale && !isStale(a, args.valuations, args.today)) {
      out.push({ ...base, skipped: true });
      continue;
    }
    try {
      const r = await valueFor(a, args.keys, args.fetchFn, args.today);
      const same = args.valuations.find((v) => v.assetId === a.id && v.date === args.today && v.source !== "PURCHASE" && v.source !== "SALE");
      const row = { assetId: a.id, date: args.today, value: r.value, source: "ESTIMATE", notes: r.note };
      const w = same ? await M.homeFinanceAssetValuation.update({ id: same.id, ...row }) : await M.homeFinanceAssetValuation.create(row);
      if (w.errors?.length) throw new Error(w.errors[0].message);
      if (!a.valuedOn || a.valuedOn <= args.today) {
        const u = await M.homeFinanceAsset.update({ id: a.id, currentValue: r.value, valuedOn: args.today });
        if (u.errors?.length) throw new Error(u.errors[0].message);
      }
      out.push({ ...base, value: r.value, change: base.previous != null ? round2(r.value - base.previous) : null });
    } catch (e) {
      out.push({ ...base, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
