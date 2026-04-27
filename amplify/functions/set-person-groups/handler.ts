// setPersonGroups — admin-only mutation that synchronises a homePerson
// row's group membership across Cognito (the source of truth for
// AppSync auth) and the homePerson.groups cache (used by the UI for
// fast filtering without re-querying Cognito on every render).
//
// The diff algorithm is intentionally simple:
//   current = AdminListGroupsForUser(sub)
//   desired = arguments.groups
//   add    = desired \ current
//   remove = current \ desired
// then write the desired list back to homePerson.groups.
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

interface Args {
  personId: string;
  groups: string[];
}

interface Identity {
  groups?: string[];
  username?: string;
}

export const handler: AppSyncResolverHandler<
  Args,
  Schema["homePerson"]["type"] | null
> = async (event) => {
  // Caller must be in admins. AppSync passes Cognito identity through
  // event.identity; we double-check here even though the schema's
  // allow.group("admins") rule already gates the resolver.
  const identity = event.identity as Identity | undefined;
  const callerGroups = identity?.groups ?? [];
  if (!callerGroups.includes("admins")) {
    throw new Error("Forbidden: admins only");
  }

  const { personId, groups: desiredGroups } = event.arguments;
  if (!personId || !Array.isArray(desiredGroups)) {
    throw new Error("personId and groups[] are required");
  }
  // Dedup + drop empties so we don't churn Cognito over case-fold
  // collisions or stray strings from the UI.
  const desired = [...new Set(desiredGroups.map((g) => g.trim()).filter(Boolean))];

  const { data: person, errors } = await client.models.homePerson.get({
    id: personId,
  });
  if (errors?.length) throw new Error(errors[0].message);
  if (!person) throw new Error(`homePerson ${personId} not found`);
  if (!person.cognitoUsername) {
    throw new Error("Cannot set groups: homePerson has no cognitoUsername link");
  }
  const sub = person.cognitoUsername;

  // Diff against the live Cognito state, not against
  // person.groups — the cache could be stale and we want to
  // converge on Cognito as the source of truth.
  const liveRes = await cognito.send(
    new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: sub,
    })
  );
  const live = (liveRes.Groups ?? [])
    .map((g) => g.GroupName ?? "")
    .filter(Boolean);

  const toAdd = desired.filter((g) => !live.includes(g));
  const toRemove = live.filter((g) => !desired.includes(g));

  for (const g of toAdd) {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: sub,
        GroupName: g,
      })
    );
  }
  for (const g of toRemove) {
    await cognito.send(
      new AdminRemoveUserFromGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: sub,
        GroupName: g,
      })
    );
  }

  // Write the cache only after Cognito accepts every change. If a
  // Cognito call throws above, the homePerson.groups cache stays
  // stale rather than diverging from reality.
  const { data: updated, errors: updErrs } = await client.models.homePerson.update({
    id: personId,
    groups: desired,
  });
  if (updErrs?.length) throw new Error(updErrs[0].message);
  return updated ?? null;
};
