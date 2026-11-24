// What a "Sync now" press reports. Shared by the web finance shell and the
// phone's finance screen. The syncFinance mutation starts the run in the
// background ({ ok, status: "STARTED", requestedAt }) because a run can
// outlast AppSync's 30s; waitForSync then watches homeFinanceSyncLog for the
// run's row. An older backend (or a dry run) answers with the run summary
// itself ({ ok, accountsChecked, txInserted, txUpdated, linked, errors }).

/* eslint-disable @typescript-eslint/no-explicit-any */

export type SyncOutcome = { ok: boolean; title: string; detail?: string };

function parse(data: unknown): any {
  let d: any = data;
  while (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      break;
    }
  }
  return d;
}

/** `data` is the mutation's result (AWSJSON, possibly still a string); `error` a GraphQL error message. */
export function describeSyncResult(data: unknown, error?: string | null): SyncOutcome {
  const d = parse(data);
  if (error || !d?.ok) return { ok: false, title: "Sync failed", detail: error ?? d?.errors?.[0] ?? "" };
  if (!d.accountsChecked) return { ok: true, title: "No accounts linked to SimpleFIN yet" };
  const parts = [`${d.txInserted ?? 0} new`, `${d.txUpdated ?? 0} updated`];
  if (d.linked) parts.push(`${d.linked} matched to schedules`);
  const outcome: SyncOutcome = { ok: true, title: "Synced", detail: parts.join(", ") };
  const errs: string[] = Array.isArray(d.errors) ? d.errors : [];
  if (errs.length) outcome.detail = `${outcome.detail}\n\n${errs.join("\n")}`;
  return outcome;
}

/** A homeFinanceSyncLog row as the run summary describeSyncResult reads. */
export function syncLogSummary(row: any) {
  const perAccount = (parse(row?.perAccountJson) ?? []) as Array<{ linked?: number }>;
  const errors = (parse(row?.errorsJson) ?? []) as string[];
  return {
    ok: row?.status !== "ERROR",
    accountsChecked: row?.accountsChecked ?? 0,
    txInserted: row?.txInserted ?? 0,
    txUpdated: row?.txUpdated ?? 0,
    linked: Array.isArray(perAccount) ? perAccount.reduce((n, a) => n + (a?.linked ?? 0), 0) : 0,
    errors: Array.isArray(errors) ? errors : [],
  };
}

export const SYNC_WAIT_MS = 150_000;
const POLL_MS = 4_000;

/**
 * The outcome of a "Sync now" press. `data` is the mutation's result; when it
 * says the run started in the background, polls `logsSince` (MANUAL
 * homeFinanceSyncLog rows started at or after a time) until the run's row
 * shows up, or gives up after `waitMs` saying it's still running.
 */
export async function waitForSync(
  data: unknown,
  error: string | null | undefined,
  logsSince: (iso: string) => Promise<any[]>,
  opts: { waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SyncOutcome> {
  const d = parse(data);
  if (error || d?.status !== "STARTED" || !d?.requestedAt) return describeSyncResult(data, error);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? POLL_MS;
  const deadline = Date.now() + (opts.waitMs ?? SYNC_WAIT_MS);
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let rows: any[] = [];
    try {
      rows = await logsSince(d.requestedAt);
    } catch {
      continue; // a failed read isn't a failed sync; try again
    }
    const row = rows.filter((r) => r?.trigger === "MANUAL" && r?.startedAt >= d.requestedAt).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))[0];
    if (row) return describeSyncResult(syncLogSummary(row));
  }
  return { ok: true, title: "Still syncing", detail: "It keeps going in the background. Refresh in a minute to see what came in." };
}

/** logsSince for an Amplify data client (web or phone). */
export function syncLogsSince(client: any) {
  return async (iso: string) => {
    const out: any[] = [];
    let nextToken: string | null = null;
    do {
      const res: any = await client.models.homeFinanceSyncLog.list({ filter: { startedAt: { ge: iso }, trigger: { eq: "MANUAL" } }, limit: 1000, nextToken });
      out.push(...(res?.data ?? []));
      nextToken = res?.nextToken ?? null;
    } while (nextToken);
    return out;
  };
}
