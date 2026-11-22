// How the household uses the web and phone apps: page / screen opens
// logged by lib/usage.ts, summarized for /admin/usage (and Janet, hh).

import { z } from "zod/v4";
import { getHouseholdTimezone } from "../household-settings";
import { listAllPages } from "../list-all";
import { monthsBetween, summarizeUsage, type UsageEventLike } from "../usage";
import type { OpContext } from "./context";
import { OpError, defineOp } from "./define";

const FIELDS = "username platform screen at";

/** Events in [fromIso, toIso], one month-partition query at a time. */
async function loadEvents(ctx: OpContext, fromIso: string, toIso: string): Promise<UsageEventLike[]> {
  const client = ctx.client;
  // A fake client in tests has no graphql: list the model and filter.
  if (typeof client.graphql !== "function") {
    const rows = await listAllPages<any>(client.models.homeUsageEvent); // eslint-disable-line @typescript-eslint/no-explicit-any
    return rows.filter((r) => r.at >= fromIso && r.at <= toIso);
  }
  const query = `query Q($month: String!, $at: ModelStringKeyConditionInput, $limit: Int, $nextToken: String) {
    listHomeUsageEventByMonthAndAt(month: $month, at: $at, limit: $limit, nextToken: $nextToken) { items { ${FIELDS} } nextToken }
  }`;
  const perMonth = await Promise.all(
    monthsBetween(fromIso, toIso).map(async (month) => {
      const out: UsageEventLike[] = [];
      let nextToken: string | null = null;
      do {
        let res: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        try {
          res = await client.graphql({ query, variables: { month, at: { between: [fromIso, toIso] }, limit: 1000, nextToken } });
        } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
          throw new OpError(`Couldn't read usage: ${e?.errors?.[0]?.message ?? e?.message ?? String(e)}`);
        }
        const conn = res?.data?.listHomeUsageEventByMonthAndAt;
        out.push(...(conn?.items ?? []));
        nextToken = conn?.nextToken ?? null;
      } while (nextToken);
      return out;
    }),
  );
  return perMonth.flat();
}

const Count = z.object({ name: z.string(), views: z.number() });

export const getUsageReport = defineOp({
  name: "get_usage_report",
  domain: "usage",
  access: "read",
  description:
    "How the household uses the Home Hub web and phone apps over a period: page / screen opens (views), visits (a run of use with no 30-minute gap), active days, per person (web vs iPhone vs Android, last seen), the most-used pages and screens with who uses them, and views per day. Answers 'which pages do we use most?', 'how often does Cris open the app?', 'is anyone using the Budget page?'. Screens are route patterns (/trips/[id]); web and phone screens are listed separately.",
  input: z.object({
    days: z.number().int().min(1).max(365).optional().describe("The last N days, today included. Default 30. Ignored when from is given."),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("First day, YYYY-MM-DD."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last day, YYYY-MM-DD. Default today."),
    personName: z.string().optional().describe("Only this person."),
  }),
  output: z.object({
    from: z.string(),
    to: z.string(),
    views: z.number(),
    visits: z.number(),
    activeDays: z.number(),
    people: z.array(z.object({ username: z.string(), name: z.string(), views: z.number(), visits: z.number(), web: z.number(), ios: z.number(), android: z.number(), lastSeen: z.string() })),
    screens: z.array(z.object({ screen: z.string(), kind: z.enum(["web", "phone"]), views: z.number(), people: z.array(Count), lastSeen: z.string() })),
    days: z.array(z.object({ day: z.string(), views: z.number(), visits: z.number(), people: z.number() })),
  }),
  async run(ctx, input) {
    const timeZone = await getHouseholdTimezone(ctx.client);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const to = input.to ?? today;
    const from = input.from ?? new Date(Date.parse(`${to}T12:00:00Z`) - ((input.days ?? 30) - 1) * 86400000).toISOString().slice(0, 10);
    if (from > to) throw new OpError("from is after to");
    // Local days → a UTC window wide enough for any timezone; trimmed below.
    const fromIso = new Date(Date.parse(`${from}T00:00:00Z`) - 14 * 3600000).toISOString();
    const toIso = new Date(Date.parse(`${to}T23:59:59Z`) + 14 * 3600000).toISOString();

    const [events, people] = await Promise.all([loadEvents(ctx, fromIso, toIso), listAllPages<any>(ctx.client.models.homePerson)]); // eslint-disable-line @typescript-eslint/no-explicit-any
    const names = new Map<string, string>();
    for (const p of people) if (p.cognitoUsername) names.set(p.cognitoUsername, p.name), names.set(p.cognitoUsername.toLowerCase(), p.name);
    const local = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
    let inRange = events.filter((e) => {
      const d = local(e.at);
      return d >= from && d <= to;
    });
    if (input.personName) {
      const want = input.personName.trim().toLowerCase();
      inRange = inRange.filter((e) => (names.get(e.username) ?? e.username).toLowerCase() === want);
    }
    return { from, to, ...summarizeUsage(inRange, { timeZone, names }) };
  },
});

export const usageOps = [getUsageReport] as const;
