/**
 * Mock week for a sandbox, to see the week planner (/week) with data: this
 * week and next, relative to today. Appointments that drive office/home
 * (Cris's PT on Tuesday, an OB visit on an office day), a double-booking,
 * a recurring gym, a household plumber visit, unassigned "family calendar"
 * events (one names Dolce), office/home statuses, Dolce's daycare, tasks
 * (one overdue), a trip next week with flights, a hotel and a half-done
 * packing list, and a birthday.
 *
 * Every row it writes is tagged seed:week-dev; --reset removes only those.
 * No reminders: the sandbox's reminder sweep would actually send them.
 *
 * Usage (after `npm run seed:dev`):
 *   npm run seed:week-dev
 *   npm run seed:week-dev -- --reset     # remove the mock rows, then seed again
 *   npm run seed:week-dev -- --remove    # just remove them
 *
 * Refuses to run unless the user pool is tagged amplify:deployment-type=sandbox.
 */
import { readFile } from "node:fs/promises";
import { Amplify } from "aws-amplify";
import { signIn, signOut } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { CognitoIdentityProviderClient, DescribeUserPoolCommand } from "@aws-sdk/client-cognito-identity-provider";
import { fromIni } from "@aws-sdk/credential-providers";
import type { Schema } from "../amplify/data/resource";
import { listAllPages } from "../lib/list-all";
import { mondayOf } from "../lib/week-plan";
import { zonedMidnight } from "../lib/week-sections";
import { todayIso } from "../lib/finance/dates";

/* eslint-disable @typescript-eslint/no-explicit-any */

const argv = process.argv;
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const opts = {
  email: arg("email", "gennaroanesi@gmail.com"),
  password: arg("password", "Rustic91!"),
  profile: arg("profile", "amplify-dev"),
  reset: argv.includes("--reset"),
  remove: argv.includes("--remove"),
};

const TAG = "seed:week-dev";
const TZ = "America/Chicago";

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** ISO instant for a local Chicago date + HH:MM. */
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(zonedMidnight(date, TZ).getTime() + (h * 60 + m) * 60_000).toISOString();
};
// Trip legs and reservations store the local wall clock with a placeholder Z (lib/trip.ts).
const wall = (date: string, hhmm: string) => `${date}T${hhmm}:00.000Z`;

async function removeMock(m: any) {
  const del = async (model: string, rows: any[]) => {
    for (const r of rows) await m[model].delete({ id: r.id });
    if (rows.length) console.log(`  removed ${rows.length} ${model}`);
  };
  const tagged = (field: string) => (r: any) => String(r[field] ?? "").includes(TAG);
  await del("homeCalendarEvent", (await listAllPages<any>(m.homeCalendarEvent)).filter(tagged("description")));
  await del("homeCalendarFeed", (await listAllPages<any>(m.homeCalendarFeed)).filter((f) => f.url?.includes("seed-week-dev")));
  await del("homeCalendarDay", (await listAllPages<any>(m.homeCalendarDay)).filter(tagged("notes")));
  await del("homePetDay", (await listAllPages<any>(m.homePetDay)).filter(tagged("notes")));
  await del("homeTask", (await listAllPages<any>(m.homeTask)).filter(tagged("description")));
  const trips = (await listAllPages<any>(m.homeTrip)).filter(tagged("notes"));
  const tripIds = new Set(trips.map((t) => t.id));
  await del("homeTripLeg", (await listAllPages<any>(m.homeTripLeg)).filter((l) => tripIds.has(l.tripId)));
  await del("homeTripReservation", (await listAllPages<any>(m.homeTripReservation)).filter((r) => tripIds.has(r.tripId)));
  const lists = (await listAllPages<any>(m.homeChecklist)).filter((c) => tripIds.has(c.entityId));
  const listIds = new Set(lists.map((c) => c.id));
  await del("homeChecklistItem", (await listAllPages<any>(m.homeChecklistItem)).filter((i) => listIds.has(i.checklistId)));
  await del("homeChecklist", lists);
  await del("homeTrip", trips);
  await del("homePerson", (await listAllPages<any>(m.homePerson)).filter((p) => p.name?.endsWith("(mock)")));
}

async function main() {
  const outputs = JSON.parse(await readFile("./amplify_outputs.json", "utf8"));
  const poolId: string = outputs.auth.user_pool_id;
  const cognito = new CognitoIdentityProviderClient({ region: outputs.auth.aws_region, credentials: fromIni({ profile: opts.profile }) });
  const pool = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
  const deploymentType = pool.UserPool?.UserPoolTags?.["amplify:deployment-type"];
  if (deploymentType !== "sandbox") throw new Error(`User pool ${poolId} is ${deploymentType ?? "untagged"}, not a sandbox. Refusing.`);

  Amplify.configure(outputs, { ssr: false });
  await signOut().catch(() => {});
  const res = await signIn({ username: opts.email, password: opts.password });
  if (!res.isSignedIn) throw new Error("Sign-in incomplete");
  const m: any = generateClient<Schema>({ authMode: "userPool" }).models;

  const existing = (await listAllPages<any>(m.homeCalendarEvent)).filter((e) => String(e.description ?? "").includes(TAG));
  if (opts.remove || opts.reset) {
    await removeMock(m);
    if (opts.remove) return;
  } else if (existing.length) {
    throw new Error(`Mock week already seeded (${existing.length} events). Re-run with --reset to replace it, or --remove.`);
  }

  const people = await listAllPages<any>(m.homePerson);
  const gen = people.find((p) => p.name === "Gennaro");
  const cris = people.find((p) => p.name === "Cristine");
  if (!gen || !cris) throw new Error("Run `npm run seed:dev` first (needs Gennaro and Cristine).");
  const dolce = (await listAllPages<any>(m.homePet)).find((p) => p.name === "Dolce");

  const W = mondayOf(todayIso(TZ)); // this week
  const N = addDays(W, 7); // next week
  const day = (week: string, i: number) => addDays(week, i); // 0 = Monday

  const created: Record<string, number> = {};
  const make = async (model: string, row: any) => {
    const r = await m[model].create(row);
    if (r.errors?.length) throw new Error(`${model}: ${r.errors[0].message}`);
    created[model] = (created[model] ?? 0) + 1;
    return r.data;
  };
  const event = (title: string, date: string, start: string | null, end: string | null, who: string[], extra: any = {}) =>
    make("homeCalendarEvent", {
      title,
      description: `Mock event (${TAG})`,
      startAt: start ? at(date, start) : `${date}T00:00:00.000Z`,
      endAt: start ? (end ? at(date, end) : null) : `${addDays(date, 1)}T00:00:00.000Z`,
      isAllDay: !start,
      assignedPersonIds: who,
      ...extra,
    });

  // A switched-off "family calendar" feed, so mock events look imported
  // (ics-sync skips inactive feeds, so it never touches them).
  const feed = await make("homeCalendarFeed", { name: "Family calendar (mock)", url: "https://example.invalid/seed-week-dev.ics", color: "#8e6c8a", active: false });
  const fromFeed = (title: string, date: string, start: string | null, end: string | null) => event(title, date, start, end, [], { feedId: feed.id, externalUid: `${TAG}-${title}-${date}` });

  for (const week of [W, N]) {
    // Cris
    await event("Physical therapy", day(week, 1), "10:00", "11:00", [cris.id]); // Tue 10am → "home?"
    await event("OB visit", day(week, 3), "09:00", "10:00", [cris.id]); // Thu, on an office day
    await event("Dentist cleaning", day(week, 3), "09:30", "10:30", [cris.id]); // overlaps the OB visit
    await event("Yoga", day(week, 0), "18:30", "19:30", [cris.id]);
    // Gennaro
    await event("Haircut", day(week, 2), "12:30", "13:15", [gen.id]);
    await event("Team dinner", day(week, 3), "19:00", "21:00", [gen.id]);
    // Both / household
    await event("Dinner with Marilene & Paulo", day(week, 5), "19:00", "21:30", [gen.id, cris.id]);
    await event("Plumber visit", day(week, 2), "13:00", "15:00", []);
    // From the family calendar, nobody assigned yet
    await fromFeed("Appt Dr. Crozier", day(week, 0), "11:00", "11:45");
    await fromFeed("Car service", day(week, 4), "08:00", "09:00");
    await fromFeed("Dolce Barkin Creek", day(week, 3), "07:45", "08:15");
    await fromFeed("Farmers market", day(week, 6), null, null);
  }
  // Recurring: Gennaro's gym, Mon/Wed/Fri 6:30.
  await event("Gym", day(W, 0), "06:30", "07:30", [gen.id], { recurrence: "FREQ=WEEKLY;BYDAY=MO,WE,FR" });

  // Office / home this week: Gennaro set; Cris office Mon and Thu (OB that
  // morning → "still the office?"), Tue–Wed and Fri left for the review.
  const status = (personId: string, date: string, s: string) => make("homeCalendarDay", { personId, date, status: s, notes: TAG });
  for (const [i, s] of [[0, "WORKING_HOME"], [1, "WORKING_OFFICE"], [2, "WORKING_HOME"], [3, "WORKING_OFFICE"], [4, "WORKING_HOME"]] as const) await status(gen.id, day(W, i), s);
  await status(cris.id, day(W, 0), "WORKING_OFFICE");
  await status(cris.id, day(W, 3), "WORKING_OFFICE");

  if (dolce) await make("homePetDay", { petId: dolce.id, date: day(W, 3), status: "DAYCARE", notes: TAG });

  // Tasks: one overdue, one this week, one recurring-free next week.
  await make("homeTask", { title: "Renew car registration", description: TAG, dueDate: at(day(W, -3), "17:00"), assignedPersonIds: [gen.id], isCompleted: false });
  await make("homeTask", { title: "Confirm plumber time", description: TAG, dueDate: at(day(W, 1), "12:00"), assignedPersonIds: [cris.id], isCompleted: false });
  await make("homeTask", { title: "Order crib mattress", description: TAG, dueDate: at(day(N, 2), "12:00"), assignedPersonIds: [], isCompleted: false });

  // Next week: Gennaro to Austin Thu–Sat, flights, hotel, packing list half done.
  const trip = await make("homeTrip", { name: "Austin (work)", type: "WORK", startDate: day(N, 3), endDate: day(N, 5), participantIds: [gen.id], notes: TAG });
  await make("homeTripLeg", {
    tripId: trip.id,
    mode: "COMMERCIAL_FLIGHT",
    airline: "AA",
    flightNumber: "2311",
    departAt: wall(day(N, 3), "07:30"),
    arriveAt: wall(day(N, 3), "08:35"),
    fromLocation: { airportCode: "DFW", city: "Dallas", timezone: TZ },
    toLocation: { airportCode: "AUS", city: "Austin", timezone: TZ },
    sortOrder: 0,
  });
  await make("homeTripLeg", {
    tripId: trip.id,
    mode: "COMMERCIAL_FLIGHT",
    airline: "AA",
    flightNumber: "2874",
    departAt: wall(day(N, 5), "16:10"),
    arriveAt: wall(day(N, 5), "17:15"),
    fromLocation: { airportCode: "AUS", city: "Austin", timezone: TZ },
    toLocation: { airportCode: "DFW", city: "Dallas", timezone: TZ },
    sortOrder: 1,
  });
  await make("homeTripReservation", { tripId: trip.id, type: "HOTEL", name: "Hotel Van Zandt", startAt: wall(day(N, 3), "15:00"), endAt: wall(day(N, 5), "11:00"), sortOrder: 0 });
  const list = await make("homeChecklist", { entityType: "TRIP", entityId: trip.id, name: "Packing" });
  for (const [i, [text, done]] of ([["Laptop + charger", true], ["Suit", false], ["Badge", false]] as const).entries()) {
    await make("homeChecklistItem", { checklistId: list.id, text, isDone: done, sortOrder: i });
  }

  // A birthday next week (a non-household person, so it only shows in Birthdays).
  await make("homePerson", { name: "Marilene (mock)", birthday: `1958-${day(N, 5).slice(5)}`, active: true, groups: [] });

  console.log(`Mock week seeded for ${W} and ${N}:`);
  for (const [k, n] of Object.entries(created)) console.log(`  ${n} ${k}`);
  console.log("Open http://localhost:3001/week (and ?week=" + N + " for next week).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
