import { describe, expect, it } from "vitest";
import { describeSyncResult, syncLogSummary, waitForSync } from "./sync-result";

const noSleep = async () => {};

describe("describeSyncResult", () => {
  it("reports counts and any errors", () => {
    expect(describeSyncResult({ ok: true, accountsChecked: 3, txInserted: 2, txUpdated: 1, linked: 1, errors: [] })).toEqual({ ok: true, title: "Synced", detail: "2 new, 1 updated, 1 matched to schedules" });
    expect(describeSyncResult(JSON.stringify({ ok: true, accountsChecked: 3, txInserted: 0, txUpdated: 0, errors: ["Cristine's connection didn't return X"] })).detail).toBe("0 new, 0 updated\n\nCristine's connection didn't return X");
    expect(describeSyncResult(null, "Execution timed out")).toEqual({ ok: false, title: "Sync failed", detail: "Execution timed out" });
  });
});

describe("syncLogSummary", () => {
  it("sums linked over accounts and reads errors", () => {
    const s = syncLogSummary({ status: "PARTIAL", accountsChecked: 2, txInserted: 4, txUpdated: 0, perAccountJson: JSON.stringify([{ linked: 1 }, { linked: 2 }]), errorsJson: JSON.stringify(["boom"]) });
    expect(s).toEqual({ ok: true, accountsChecked: 2, txInserted: 4, txUpdated: 0, linked: 3, errors: ["boom"] });
    expect(syncLogSummary({ status: "ERROR" }).ok).toBe(false);
  });
});

describe("waitForSync", () => {
  const started = JSON.stringify({ ok: true, status: "STARTED", requestedAt: "2026-11-24T12:00:00.000Z" });

  it("passes an inline summary straight through", async () => {
    const out = await waitForSync({ ok: true, accountsChecked: 1, txInserted: 1, txUpdated: 0 }, null, async () => [], { sleep: noSleep });
    expect(out.title).toBe("Synced");
  });

  it("waits for the run's log row, ignoring older and cron rows", async () => {
    let calls = 0;
    const out = await waitForSync(
      started,
      null,
      async () => {
        calls++;
        const old = { trigger: "MANUAL", startedAt: "2026-11-24T11:00:00.000Z", status: "OK", accountsChecked: 1, txInserted: 99 };
        const cron = { trigger: "CRON", startedAt: "2026-11-24T12:00:01.000Z", status: "OK", accountsChecked: 1, txInserted: 50 };
        const mine = { trigger: "MANUAL", startedAt: "2026-11-24T12:00:01.000Z", status: "OK", accountsChecked: 11, txInserted: 6, txUpdated: 0, perAccountJson: "[]", errorsJson: "[]" };
        return calls < 3 ? [old, cron] : [old, cron, mine];
      },
      { sleep: noSleep },
    );
    expect(calls).toBe(3);
    expect(out).toEqual({ ok: true, title: "Synced", detail: "6 new, 0 updated" });
  });

  it("reports a failed run", async () => {
    const out = await waitForSync(started, null, async () => [{ trigger: "MANUAL", startedAt: "2026-11-24T12:00:02.000Z", status: "ERROR", errorsJson: JSON.stringify(["SimpleFIN fetch failed"]) }], { sleep: noSleep });
    expect(out).toEqual({ ok: false, title: "Sync failed", detail: "SimpleFIN fetch failed" });
  });

  it("gives up as still running", async () => {
    const out = await waitForSync(started, null, async () => [], { sleep: noSleep, waitMs: -1 });
    expect(out.title).toBe("Still syncing");
  });
});
