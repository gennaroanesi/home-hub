import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_ACCOUNT_FORM,
  accountFormFrom,
  accountHasTransactions,
  accountWriteRow,
  deleteAccountWithHoldings,
  newAccountForm,
  parseSimplefinListing,
  pickSimplefinAccount,
  saveAccountForm,
  simplefinInstitutions,
  simplefinPickerGroups,
  typeSimplefinAccountId,
  validateAccountForm,
} from "./account-form";

const NOW = new Date("2026-11-15T12:00:00.000Z");

describe("account form", () => {
  it("starts a new account after the existing ones on the default connection", () => {
    const f = newAccountForm(3);
    expect(f.sortOrder).toBe("40");
    expect(f.type).toBe("CHECKING");
    expect(f.simplefinConnection).toBe("gennaro");
    expect(f.id).toBeUndefined();
  });

  it("fills from a row: percents, nulls, default connection, joint owners", () => {
    const f = accountFormFrom({
      id: "a1",
      name: "Card",
      type: "CREDIT",
      currentBalance: -120.5,
      ownerPersonIds: ["p1", null],
      apr: 0.2499,
      statementDueDay: 12,
      simplefinAccountId: "ACT-1",
      simplefinConnection: null,
      active: null,
    });
    expect(f).toMatchObject({ id: "a1", currentBalance: "-120.5", ownerPersonIds: ["p1"], apr: "24.99", apy: "", statementDueDay: "12", simplefinConnection: "gennaro", active: true, retirementType: "_401K", notes: "" });
    expect(accountFormFrom({ id: "a2", name: "X", active: false, simplefinConnection: "cristine" })).toMatchObject({ type: "OTHER", currentBalance: "0", active: false, simplefinConnection: "cristine" });
  });

  it("validates name, statement day and SimpleFIN clashes", () => {
    const accounts = [
      { id: "a1", name: "Joint", simplefinAccountId: "ACT-1" },
      { id: "a2", name: "Savings", simplefinAccountId: null },
    ];
    expect(validateAccountForm({ ...EMPTY_ACCOUNT_FORM, name: "  " }, accounts)).toBe("Name is required");
    expect(validateAccountForm({ ...EMPTY_ACCOUNT_FORM, name: "C", statementDueDay: "32" }, accounts)).toBe("Statement due day must be 1–31");
    expect(validateAccountForm({ ...EMPTY_ACCOUNT_FORM, name: "C", statementDueDay: "0" }, accounts)).toBe("Statement due day must be 1–31");
    expect(validateAccountForm({ ...EMPTY_ACCOUNT_FORM, name: "C", statementDueDay: "31" }, accounts)).toBeNull();
    expect(validateAccountForm({ ...EMPTY_ACCOUNT_FORM, name: "C", simplefinAccountId: " ACT-1 " }, accounts)).toBe("That SimpleFIN account is already linked to Joint");
    expect(validateAccountForm({ ...EMPTY_ACCOUNT_FORM, id: "a1", name: "Joint", simplefinAccountId: "ACT-1" }, accounts)).toBeNull();
  });

  it("builds the row: type-dependent fields, connection only with an id, percent → decimal", () => {
    const row = accountWriteRow(
      { ...EMPTY_ACCOUNT_FORM, name: " Card ", type: "CREDIT", creditLimit: "5000", statementDueDay: "12", apr: "24.99", apy: "4", minBalance: "100", simplefinAccountId: "", simplefinConnection: "cristine", institution: " ", last4: "1234" },
      null,
      NOW,
    );
    expect(row).toMatchObject({ name: "Card", type: "CREDIT", creditLimit: 5000, statementDueDay: 12, apy: null, minBalance: null, retirementType: null, institution: null, last4: "1234", simplefinAccountId: null, simplefinConnection: null, sortOrder: null, notes: null });
    expect(row.apr).toBeCloseTo(0.2499);

    const ret = accountWriteRow({ ...EMPTY_ACCOUNT_FORM, name: "401k", type: "RETIREMENT", retirementType: "ROTH_IRA", simplefinAccountId: "ACT-9", simplefinConnection: "cristine", sortOrder: "20" }, null, NOW);
    expect(ret).toMatchObject({ retirementType: "ROTH_IRA", simplefinAccountId: "ACT-9", simplefinConnection: "cristine", sortOrder: 20, creditLimit: null, apr: null });

    const sav = accountWriteRow({ ...EMPTY_ACCOUNT_FORM, name: "S", type: "SAVINGS", apy: "4.25", minBalance: "50" }, null, NOW);
    expect(sav.apy).toBeCloseTo(0.0425);
    expect(sav.minBalance).toBeNull();
    expect(accountWriteRow({ ...EMPTY_ACCOUNT_FORM, name: "C", minBalance: "500" }, null, NOW).minBalance).toBe(500);
  });

  it("stamps balanceUpdatedAt only for a new account or a changed balance", () => {
    const f = { ...EMPTY_ACCOUNT_FORM, id: "a1", name: "J", currentBalance: "100" };
    expect(accountWriteRow(f, null, NOW).balanceUpdatedAt).toBe(NOW.toISOString());
    expect(accountWriteRow(f, { currentBalance: 100.004 }, NOW)).not.toHaveProperty("balanceUpdatedAt");
    expect(accountWriteRow(f, { currentBalance: 99.99 }, NOW).balanceUpdatedAt).toBe(NOW.toISOString());
    expect(accountWriteRow({ ...f, currentBalance: "abc" }, { currentBalance: null }, NOW)).toMatchObject({ currentBalance: 0 });
    expect(accountWriteRow({ ...f, currentBalance: "abc" }, { currentBalance: null }, NOW)).not.toHaveProperty("balanceUpdatedAt");
  });

  it("saves through the model: validation first, create vs update", async () => {
    const create = vi.fn(async () => ({ data: {} }));
    const update = vi.fn(async () => ({ data: {} }));
    const client = { models: { homeFinanceAccount: { create, update } } };
    const accounts = [{ id: "a1", name: "Joint", currentBalance: 10, simplefinAccountId: "ACT-1" }];
    expect(await saveAccountForm(client, { ...EMPTY_ACCOUNT_FORM, name: "N", simplefinAccountId: "ACT-1" }, accounts)).toMatch(/already linked to Joint/);
    expect(create).not.toHaveBeenCalled();
    expect(await saveAccountForm(client, { ...EMPTY_ACCOUNT_FORM, name: "N" }, accounts)).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(await saveAccountForm(client, { ...EMPTY_ACCOUNT_FORM, id: "a1", name: "Joint", currentBalance: "10", simplefinAccountId: "ACT-1" }, accounts)).toBeNull();
    const arg = (update.mock.calls[0] as any[])[0];
    expect(arg).toMatchObject({ id: "a1", simplefinConnection: "gennaro" });
    expect(arg).not.toHaveProperty("balanceUpdatedAt");
    update.mockResolvedValueOnce({ errors: [{ message: "nope" }] } as any);
    await expect(saveAccountForm(client, { ...EMPTY_ACCOUNT_FORM, id: "a1", name: "Joint" }, accounts)).rejects.toThrow("nope");
  });
});

describe("SimpleFIN picker", () => {
  const listing = parseSimplefinListing(
    JSON.stringify(
      JSON.stringify({
        accounts: [
          { id: "ACT-1", institution: "Chase", name: "Checking", connection: "gennaro", mappedTo: { id: "a1", name: "Joint" } },
          { id: "ACT-2", institution: "Amex", name: "Gold", connection: "gennaro", mappedTo: null },
          { id: "ACT-3", institution: "Fidelity", name: "401k", connection: "cristine", mappedTo: null },
        ],
        connections: [
          { key: "gennaro", label: "Gennaro", ok: true, error: null },
          { key: "cristine", label: "Cristine", ok: false, error: "Not set up yet" },
        ],
      }),
    ),
  );

  it("parses layered AWSJSON", () => {
    expect(listing.accounts).toHaveLength(3);
    expect(listing.error).toBeNull();
    expect(parseSimplefinListing(null)).toEqual({ accounts: [], connections: [], error: null });
    expect(parseSimplefinListing({ error: "boom" }).error).toBe("boom");
  });

  it("groups by connection with selected / taken per row", () => {
    const groups = simplefinPickerGroups(listing, { ...EMPTY_ACCOUNT_FORM, id: "a2", simplefinAccountId: "ACT-2", simplefinConnection: "gennaro" });
    expect(groups.map((g) => [g.key, g.ok, g.error, g.rows.map((r) => r.id)])).toEqual([
      ["gennaro", true, null, ["ACT-1", "ACT-2"]],
      ["cristine", false, "Not set up yet", ["ACT-3"]],
    ]);
    expect(groups[0].rows.map((r) => [r.selected, r.taken])).toEqual([
      [false, true],
      [true, false],
    ]);
    // The account already linked to it isn't "taken" for itself.
    expect(simplefinPickerGroups(listing, { ...EMPTY_ACCOUNT_FORM, id: "a1" })[0].rows[0].taken).toBe(false);
    // Same id on another connection isn't selected.
    expect(simplefinPickerGroups(listing, { ...EMPTY_ACCOUNT_FORM, simplefinAccountId: "ACT-2", simplefinConnection: "cristine" })[0].rows[1].selected).toBe(false);
  });

  it("filters by words, connection, institution and linked, keeping the current pick", () => {
    const g = (filter: Parameters<typeof simplefinPickerGroups>[2], form: Parameters<typeof simplefinPickerGroups>[1] = null) =>
      simplefinPickerGroups(listing, form, filter).map((x) => [x.key, x.rows.map((r) => r.id), x.total]);
    expect(g({ query: "che" })).toEqual([
      ["gennaro", ["ACT-1"], 2],
      ["cristine", [], 1],
    ]);
    expect(g({ query: "fidelity 401" })).toEqual([
      ["gennaro", [], 2],
      ["cristine", ["ACT-3"], 1],
    ]);
    expect(g({ query: "act-2" })[0][1]).toEqual(["ACT-2"]);
    expect(g({ connection: "cristine" })).toEqual([["cristine", ["ACT-3"], 1]]);
    expect(g({ institution: "Amex" })[0][1]).toEqual(["ACT-2"]);
    expect(g({ hideLinked: true })[0][1]).toEqual(["ACT-2"]);
    // The linked-elsewhere row stays when it's this form's own link, and the current pick survives any filter.
    expect(g({ hideLinked: true }, { ...EMPTY_ACCOUNT_FORM, id: "a1" })[0][1]).toEqual(["ACT-1", "ACT-2"]);
    expect(g({ query: "zzz" }, { ...EMPTY_ACCOUNT_FORM, simplefinAccountId: "ACT-2", simplefinConnection: "gennaro" })[0][1]).toEqual(["ACT-2"]);
    expect(simplefinInstitutions(listing.accounts)).toEqual(["Amex", "Chase", "Fidelity"]);
  });

  it("falls back to the configured connections when the listing names none", () => {
    const groups = simplefinPickerGroups({ accounts: [], connections: [] }, null);
    expect(groups.map((g) => [g.key, g.ok])).toEqual([
      ["gennaro", true],
      ["cristine", true],
    ]);
  });

  it("picking sets id + connection and fills an empty institution only", () => {
    const s = { id: "ACT-3", connection: "cristine", institution: "Fidelity" };
    expect(pickSimplefinAccount({ ...EMPTY_ACCOUNT_FORM }, s)).toMatchObject({ simplefinAccountId: "ACT-3", simplefinConnection: "cristine", institution: "Fidelity" });
    expect(pickSimplefinAccount({ ...EMPTY_ACCOUNT_FORM, institution: "Mine" }, s).institution).toBe("Mine");
  });

  it("a typed id the listing knows takes its connection; an unknown one keeps the form's", () => {
    const listed = [{ id: "ACT-3", connection: "cristine", institution: "Fidelity" }];
    const form = { ...EMPTY_ACCOUNT_FORM, simplefinConnection: "gennaro" };
    expect(typeSimplefinAccountId(form, " ACT-3", listed)).toMatchObject({ simplefinAccountId: "ACT-3", simplefinConnection: "cristine" });
    expect(typeSimplefinAccountId(form, "ACT-", listed)).toMatchObject({ simplefinAccountId: "ACT-", simplefinConnection: "gennaro" });
  });
});

describe("delete guard", () => {
  it("checks for transactions through the account index", async () => {
    const byIndex = vi.fn(async () => ({ data: [{ id: "t1" }] }));
    const client = { models: { homeFinanceTransaction: { listHomeFinanceTransactionByAccountIdAndDate: byIndex } } };
    expect(await accountHasTransactions(client, "a1")).toBe(true);
    expect(byIndex).toHaveBeenCalledWith({ accountId: "a1" }, { limit: 1 });
    byIndex.mockResolvedValueOnce({ data: [] });
    expect(await accountHasTransactions(client, "a1")).toBe(false);
    byIndex.mockResolvedValueOnce({ data: [], errors: [{ message: "denied" }] } as any);
    await expect(accountHasTransactions(client, "a1")).rejects.toThrow("denied");
  });

  it("deletes the account, then its holdings; stops when the delete fails", async () => {
    const delAcc = vi.fn(async () => ({ data: {} }));
    const delHolding = vi.fn(async () => ({ data: {} }));
    const list = vi.fn(async () => ({ data: [{ accountId: "a1", holdingKey: "VTI" }, { accountId: "a1", holdingKey: "CASH" }], nextToken: null }));
    const client = { models: { homeFinanceAccount: { delete: delAcc }, homeFinanceHolding: { delete: delHolding, list } } };
    await deleteAccountWithHoldings(client, "a1");
    expect(delAcc).toHaveBeenCalledWith({ id: "a1" });
    expect(delHolding.mock.calls.map((c: any[]) => c[0])).toEqual([
      { accountId: "a1", holdingKey: "VTI" },
      { accountId: "a1", holdingKey: "CASH" },
    ]);
    delAcc.mockResolvedValueOnce({ errors: [{ message: "no" }] } as any);
    delHolding.mockClear();
    await expect(deleteAccountWithHoldings(client, "a1")).rejects.toThrow("no");
    expect(delHolding).not.toHaveBeenCalled();
  });
});
