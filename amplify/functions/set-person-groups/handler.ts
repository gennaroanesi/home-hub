// setPersonGroups + invitePerson: admin-only mutations served by one
// Lambda, dispatched on the GraphQL field name.
//
// setPersonGroups synchronises a homePerson row's group membership
// across Cognito (the source of truth for AppSync auth) and the
// homePerson.groups cache (used by the UI for fast filtering without
// re-querying Cognito on every render).
//
// The diff algorithm is intentionally simple:
//   current = AdminListGroupsForUser(sub)
//   desired = arguments.groups
//   add    = desired \ current
//   remove = current \ desired
// then write the desired list back to homePerson.groups.
//
// invitePerson creates the Cognito login (Cognito emails a temporary
// password; self sign-up is off), links it to a new or existing
// homePerson, and sets its groups through the same diff.
//
// Cognito group changes only take effect on the user's next token
// refresh — the access token in their current session still carries
// the old groups. They sign out / back in (or wait for the refresh)
// to pick up new auth privileges.

import type { AppSyncResolverHandler } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
// $amplify/env/set-person-groups types the data-client config we
// pass to getAmplifyDataClientConfig; USER_POOL_ID is read from
// process.env directly (see below).
import { env } from "$amplify/env/set-person-groups";
import type { Schema } from "../../data/resource";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

const cognito = new CognitoIdentityProviderClient({});
// Set in backend.ts via addEnvironment after the user-pool is built;
// not part of the auto-generated env types. process.env is the
// simplest read path (same pattern daily-summary uses for HASS_*).
const USER_POOL_ID = process.env.USER_POOL_ID ?? "";

interface SetGroupsArgs {
  personId: string;
  groups: string[];
}

interface InviteArgs {
  personId?: string | null;
  name?: string | null;
  email: string;
  groups: string[];
}

interface Identity {
  groups?: string[];
  username?: string;
}

type Person = Schema["homePerson"]["type"];

export const handler: AppSyncResolverHandler<SetGroupsArgs | InviteArgs, Person | null> = async (event) => {
  // Caller must be in admins. AppSync passes Cognito identity through
  // event.identity; we double-check here even though the schema's
  // allow.group("admins") rule already gates the resolver.
  const identity = event.identity as Identity | undefined;
  const callerGroups = identity?.groups ?? [];
  if (!callerGroups.includes("admins")) {
    throw new Error("Forbidden: admins only");
  }
  if (event.info.fieldName === "invitePerson") return invitePerson(event.arguments as InviteArgs);
  return setPersonGroups(event.arguments as SetGroupsArgs);
};

// Dedup + drop empties so we don't churn Cognito over case-fold
// collisions or stray strings from the UI.
function cleanGroups(groups: unknown): string[] {
  if (!Array.isArray(groups)) throw new Error("groups[] is required");
  return [...new Set(groups.map((g) => String(g).trim()).filter(Boolean))];
}

async function getPerson(personId: string): Promise<Person> {
  const { data: person, errors } = await client.models.homePerson.get({ id: personId });
  if (errors?.length) throw new Error(errors[0].message);
  if (!person) throw new Error(`homePerson ${personId} not found`);
  return person;
}

async function setPersonGroups({ personId, groups }: SetGroupsArgs): Promise<Person | null> {
  if (!personId) throw new Error("personId and groups[] are required");
  const desired = cleanGroups(groups);
  const person = await getPerson(personId);
  if (!person.cognitoUsername) {
    throw new Error("Cannot set groups: homePerson has no cognitoUsername link");
  }
  await syncCognitoGroups(person.cognitoUsername, desired);

  // Write the cache only after Cognito accepts every change. If a
  // Cognito call throws above, the homePerson.groups cache stays
  // stale rather than diverging from reality.
  const { data: updated, errors: updErrs } = await client.models.homePerson.update({
    id: personId,
    groups: desired,
  });
  if (updErrs?.length) throw new Error(updErrs[0].message);
  return updated ?? null;
}

/**
 * Create the login, then link the person row and set its groups. The
 * post-confirmation trigger doesn't run for admin-created users, so the
 * link happens here.
 */
async function invitePerson(args: InviteArgs): Promise<Person | null> {
  const email = (args.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) throw new Error("A valid email is required");
  const desired = cleanGroups(args.groups);

  // Validate the row before touching Cognito, so a bad personId doesn't
  // leave a login with nobody attached.
  const existing = args.personId ? await getPerson(args.personId) : null;
  if (existing?.cognitoUsername) throw new Error(`${existing.name} already has a login`);
  const name = (existing?.name ?? args.name ?? "").trim();
  if (!name) throw new Error("name is required when inviting a new person");

  if (await cognitoUserExists(email)) {
    throw new Error(`A login for ${email} already exists`);
  }

  const created = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
        { Name: "custom:full_name", Value: name },
      ],
      DesiredDeliveryMediums: ["EMAIL"],
    })
  );
  const sub = created.User?.Attributes?.find((a) => a.Name === "sub")?.Value ?? created.User?.Username;
  if (!sub) throw new Error("Cognito did not return the new user's id");

  await syncCognitoGroups(sub, desired);

  const fields = { cognitoUsername: sub, email, groups: desired, active: true };
  const res = existing
    ? await client.models.homePerson.update({ id: existing.id, ...fields })
    : await client.models.homePerson.create({ name, ...fields });
  if (res.errors?.length) throw new Error(res.errors[0].message);
  return res.data ?? null;
}

async function cognitoUserExists(username: string): Promise<boolean> {
  try {
    await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "UserNotFoundException") return false;
    throw err;
  }
}

async function syncCognitoGroups(sub: string, desired: string[]): Promise<void> {
  // Diff against the live Cognito state, not against
  // person.groups — the cache could be stale and we want to
  // converge on Cognito as the source of truth.
  const liveRes = await cognito.send(
    new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: sub,
    })
  );
  const live = (liveRes.Groups ?? []).map((g) => g.GroupName ?? "").filter(Boolean);

  const toAdd = desired.filter((g) => !live.includes(g));
  const toRemove = live.filter((g) => !desired.includes(g));

  for (const g of toAdd) {
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: USER_POOL_ID, Username: sub, GroupName: g }));
  }
  for (const g of toRemove) {
    await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: USER_POOL_ID, Username: sub, GroupName: g }));
  }
}
