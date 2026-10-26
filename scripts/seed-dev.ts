/**
 * Bootstraps a fresh sandbox so the app is usable end to end: a login,
 * the household, settings, and a little sample data.
 *
 * Usage (after `npx ampx sandbox` has written amplify_outputs.json):
 *   npm run seed:dev
 *   npm run seed:dev -- --email you@example.com --password 'Something1!' --name "You"
 *   npm run seed:dev -- --partner-email partner@example.com   # partner gets a login too
 *   npm run seed:dev -- --no-sample                           # people + settings only
 *
 * Flags (all optional):
 *   --email <email>           Default gennaroanesi@gmail.com
 *   --password <pw>           Default Rustic91! (also used for the partner login)
 *   --name <name>             Default Gennaro
 *   --partner-name <name>     Default Cristine
 *   --partner-email <email>   Give the partner a Cognito login too
 *   --timezone <iana>         Default America/Chicago
 *   --profile <name>          AWS CLI profile for Cognito admin calls. Default amplify-dev
 *   --no-sample               Skip the sample data (pet, provider, pregnancy, shopping list)
 *
 * What it does — idempotent, safe to re-run:
 *   1. Cognito: creates the user(s) (or resets the password), permanent
 *      password, groups home-users + admins (partner: home-users).
 *      Admin-created users never fire the post-confirmation trigger, so…
 *   2. homePerson rows for both household members, linked to their
 *      Cognito sub where they have a login, with groups mirrored — the
 *      app counts someone as household by groups, not by login.
 *   3. homeSettings (household timezone).
 *   4. Sample data: a pet, a health provider, an active pregnancy for the
 *      partner with its seeded care timeline and one completed ultrasound
 *      visit, and a shopping list. Rows are matched by name, so re-runs
 *      don't duplicate them.
 *
 * Refuses to run unless the user pool in amplify_outputs.json is tagged
 * amplify:deployment-type=sandbox — it must never touch prod.
 */

import { readFile } from "node:fs/promises";
import { Amplify } from "aws-amplify";
import { signIn, signOut } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  DescribeUserPoolCommand,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { fromIni } from "@aws-sdk/credential-providers";
import type { Schema } from "../amplify/data/resource";
import { listAllPages } from "../lib/list-all";
import { seedCareTimeline } from "../lib/pregnancy";

type Person = Schema["homePerson"]["type"];

function arg(name: string, fallback: string): string;
function arg(name: string): string | undefined;
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const opts = {
  email: arg("email", "gennaroanesi@gmail.com"),
  password: arg("password", "Rustic91!"),
  name: arg("name", "Gennaro"),
  partnerName: arg("partner-name", "Cristine"),
  partnerEmail: arg("partner-email"),
  timezone: arg("timezone", "America/Chicago"),
  profile: arg("profile", "amplify-dev"),
  sample: !flag("no-sample"),
};

const step = (msg: string) => console.log(`→ ${msg}`);
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

// ── Cognito ──────────────────────────────────────────────────────────────────

async function ensureCognitoUser(
  cognito: CognitoIdentityProviderClient,
  poolId: string,
  email: string,
  name: string,
  groups: string[],
): Promise<string> {
  let sub: string | undefined;
  try {
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }));
    sub = user.UserAttributes?.find((a) => a.Name === "sub")?.Value;
    ok(`${email} exists — resetting password and groups`);
  } catch (err) {
    if (!(err instanceof UserNotFoundException)) throw err;
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: poolId,
        Username: email,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
          { Name: "custom:full_name", Value: name },
        ],
      }),
    );
    sub = created.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
    ok(`created ${email}`);
  }
  if (!sub) throw new Error(`No sub for ${email}`);

  await cognito.send(
    new AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: email, Password: opts.password, Permanent: true }),
  );
  for (const group of groups) {
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: email, GroupName: group }));
  }
  ok(`password set, groups: ${groups.join(", ")}`);
  return sub;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const outputs = JSON.parse(await readFile("./amplify_outputs.json", "utf8"));
  const poolId: string | undefined = outputs?.auth?.user_pool_id;
  const region: string | undefined = outputs?.auth?.aws_region;
  if (!poolId || !region) throw new Error("amplify_outputs.json has no auth.user_pool_id — run `npx ampx sandbox` first.");

  const cognito = new CognitoIdentityProviderClient({ region, credentials: fromIni({ profile: opts.profile }) });

  // Guard: sandbox pools only.
  const pool = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
  const deploymentType = pool.UserPool?.UserPoolTags?.["amplify:deployment-type"];
  if (deploymentType !== "sandbox") {
    throw new Error(
      `User pool ${poolId} is tagged amplify:deployment-type=${deploymentType ?? "(none)"}, not sandbox. Refusing to seed.`,
    );
  }
  console.log(`Seeding sandbox pool ${poolId} (${region}) with profile ${opts.profile}\n`);

  // 1. Logins
  step("Cognito users");
  const mySub = await ensureCognitoUser(cognito, poolId, opts.email, opts.name, ["home-users", "admins"]);
  const partnerSub = opts.partnerEmail
    ? await ensureCognitoUser(cognito, poolId, opts.partnerEmail, opts.partnerName, ["home-users"])
    : null;

  // Sign in as the (now home-users) user — the data client writes with
  // their user-pool token, same as the web app.
  Amplify.configure(outputs, { ssr: false });
  try {
    await signOut();
  } catch {
    /* no stale session */
  }
  const res = await signIn({ username: opts.email, password: opts.password });
  if (!res.isSignedIn) throw new Error(`Sign-in incomplete: ${JSON.stringify(res.nextStep)}`);
  const client = generateClient<Schema>({ authMode: "userPool" });

  // 2. Household
  step("Household members");
  const people = await listAllPages<Person>(client.models.homePerson);
  const upsertPerson = async (p: {
    name: string;
    sub: string | null;
    email: string | null;
    groups: string[];
    color: string;
    emoji: string;
  }): Promise<Person> => {
    const existing =
      (p.sub && people.find((x) => x.cognitoUsername === p.sub)) ||
      (p.email && people.find((x) => x.email?.toLowerCase() === p.email!.toLowerCase())) ||
      people.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
    const fields = {
      name: p.name,
      cognitoUsername: p.sub ?? existing?.cognitoUsername ?? null,
      email: p.email ?? existing?.email ?? null,
      groups: p.groups,
      active: true,
      defaultTimezone: opts.timezone,
      color: existing?.color ?? p.color,
      emoji: existing?.emoji ?? p.emoji,
    };
    const { data, errors } = existing
      ? await client.models.homePerson.update({ id: existing.id, ...fields })
      : await client.models.homePerson.create(fields);
    if (errors?.length || !data) throw new Error(`homePerson ${p.name}: ${errors?.[0]?.message}`);
    ok(`${existing ? "updated" : "created"} ${p.name} (${p.groups.join(", ")}${p.sub ? ", has login" : ""})`);
    return data;
  };
  const me = await upsertPerson({
    name: opts.name,
    sub: mySub,
    email: opts.email,
    groups: ["home-users", "admins"],
    color: "#3b82f6",
    emoji: "🧔",
  });
  const partner = await upsertPerson({
    name: opts.partnerName,
    sub: partnerSub,
    email: opts.partnerEmail ?? null,
    groups: ["home-users"],
    color: "#ec4899",
    emoji: "👩",
  });

  // 3. Settings
  step("Settings");
  const settings = await listAllPages<Schema["homeSettings"]["type"]>(client.models.homeSettings);
  if (settings[0]) {
    await client.models.homeSettings.update({ id: settings[0].id, householdTimezone: opts.timezone });
  } else {
    await client.models.homeSettings.create({ householdTimezone: opts.timezone });
  }
  ok(`household timezone ${opts.timezone}`);

  if (opts.sample) await seedSample(client, me, partner);

  await signOut();
  console.log(`\n✓ Done. Log in at http://localhost:3001 as ${opts.email} / ${opts.password === "Rustic91!" ? "Rustic91!" : "(your --password)"}`);
  if (opts.partnerEmail) console.log(`  Partner login: ${opts.partnerEmail} (same password)`);
}

// ── Sample data ──────────────────────────────────────────────────────────────

async function seedSample(client: ReturnType<typeof generateClient<Schema>>, me: Person, partner: Person) {
  step("Sample data");

  const findByName = async <T extends { id: string }>(model: any, field: string, value: string): Promise<T | undefined> =>
    (await listAllPages<T>(model)).find((r: any) => (r[field] ?? "").toLowerCase() === value.toLowerCase());

  // Pet
  if (await findByName(client.models.homePet, "name", "Dolce")) {
    ok("pet Dolce exists");
  } else {
    await client.models.homePet.create({ name: "Dolce", species: "DOG", breed: "Mixed", active: true });
    ok("pet Dolce");
  }

  // Health provider
  let provider = await findByName<Schema["homeHealthProvider"]["type"]>(client.models.homeHealthProvider, "name", "Dr. Sample OB");
  if (!provider) {
    const { data } = await client.models.homeHealthProvider.create({
      name: "Dr. Sample OB",
      specialty: "OB/GYN",
      practice: "Sample Women's Health",
      personIds: [partner.id],
      phones: [{ kind: "CLINIC", number: "+15125550100" }],
      active: true,
    });
    provider = data ?? undefined;
    ok("provider Dr. Sample OB");
  } else {
    ok("provider exists");
  }

  // Pregnancy (partner) — due ~20 weeks out, so the timeline has past,
  // current and upcoming items.
  const pregnancies = await listAllPages<Schema["homePregnancy"]["type"]>(client.models.homePregnancy);
  let pregnancy = pregnancies.find((p) => p.personId === partner.id && p.status === "ACTIVE");
  if (!pregnancy) {
    const due = new Date();
    due.setDate(due.getDate() + 20 * 7);
    const dueDate = due.toISOString().slice(0, 10);
    const { data, errors } = await client.models.homePregnancy.create({
      personId: partner.id,
      dueDate,
      dueDateSource: "LMP",
      providerId: provider?.id ?? null,
      status: "ACTIVE",
    });
    if (errors?.length || !data) throw new Error(`homePregnancy: ${errors?.[0]?.message}`);
    pregnancy = data;
    const { created, failed } = await seedCareTimeline(client, data.id, dueDate);
    ok(`pregnancy for ${partner.name} (due ${dueDate}), ${created} care items${failed ? `, ${failed} failed` : ""}`);
  } else {
    ok(`pregnancy for ${partner.name} exists`);
  }

  // One completed ultrasound visit to hang attachments off.
  const visits = await listAllPages<Schema["homeMedicalVisit"]["type"]>(client.models.homeMedicalVisit);
  if (visits.some((v) => v.pregnancyId === pregnancy!.id && v.kind === "ULTRASOUND")) {
    ok("ultrasound visit exists");
  } else {
    const visitAt = new Date();
    visitAt.setDate(visitAt.getDate() - 14);
    visitAt.setHours(15, 0, 0, 0);
    await client.models.homeMedicalVisit.create({
      personId: partner.id,
      providerId: provider?.id ?? null,
      pregnancyId: pregnancy!.id,
      visitAt: visitAt.toISOString(),
      kind: "ULTRASOUND",
      status: "COMPLETED",
      title: "Dating ultrasound",
      notes: "Sample visit — attach a scan or clip here to test attachments.",
      fetalHeartRate: 150,
      createdBy: me.name,
    });
    ok("completed ultrasound visit (2 weeks ago)");
  }

  // Shopping list
  if (await findByName(client.models.homeShoppingList, "name", "Supermarket")) {
    ok("shopping list exists");
  } else {
    const { data: list } = await client.models.homeShoppingList.create({ name: "Supermarket", emoji: "🛒", sortOrder: 0 });
    if (list) {
      const names = ["Milk", "Eggs", "Bananas"];
      for (let i = 0; i < names.length; i++) {
        await client.models.homeShoppingItem.create({ listId: list.id, name: names[i], sortOrder: i, addedBy: me.name });
      }
    }
    ok("shopping list Supermarket (3 items)");
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err?.message ?? err}`);
  process.exit(1);
});
