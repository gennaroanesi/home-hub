// Cognito Post-Confirmation trigger.
//
// Runs once when a new Cognito user finishes the verify-your-email
// flow. We use it to materialise / link the corresponding homePerson
// row so the rest of the app — which keys per-user data off
// homePerson.id — has somewhere to point.
//
// Match precedence (skip ones that don't apply):
//   1. Already linked: a homePerson with cognitoUsername == sub.
//      Nothing to do.
//   2. Exact email match against an unlinked homePerson. Most common
//      case: the household admin pre-created a row for face-tagging
//      (kid, partner) and is now signing them in.
//   3. Fuzzy name match against an unlinked row. Same logic the web
//      uses in lib/current-person.ts as a fallback. Handles the case
//      where the row was added without an email but the names
//      obviously match.
//   4. Create a fresh row with sub + email + name. Admin assigns
//      groups later via the People page.
//
// Failures here block the user from signing up, so we are extremely
// conservative — wrap every step, return the event on any error so
// Cognito proceeds with confirmation. The worst case is a missing
// homePerson row which the admin can create / link manually.

import type { PostConfirmationTriggerHandler } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/post-confirm-user";
import type { Schema } from "../../data/resource";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

type Person = Schema["homePerson"]["type"];

function fuzzyNameMatch(people: Person[], candidate: string): Person | null {
  const lc = candidate.toLowerCase().trim();
  if (!lc) return null;
  const firstToken = lc.split(/\s+/)[0] ?? "";

  // Pass 1: exact lowercased match.
  const exact = people.find((p) => p.name.toLowerCase() === lc);
  if (exact) return exact;

  // Pass 2: first-token match (handles "Jane Smith" → "Jane").
  if (firstToken) {
    const byToken = people.find((p) => p.name.toLowerCase() === firstToken);
    if (byToken) return byToken;
  }

  // Pass 3: person.name is a prefix of the candidate (e.g.
  // "janesmith" → "Jane"). Prefix rather than substring keeps short
  // names from matching unrelated longer strings.
  const byPrefix = people.find((p) => {
    const pname = p.name.toLowerCase();
    return pname.length >= 3 && lc.startsWith(pname);
  });
  if (byPrefix) return byPrefix;

  return null;
}

export const handler: PostConfirmationTriggerHandler = async (event) => {
  try {
    const sub = event.request.userAttributes.sub;
    const email = event.request.userAttributes.email ?? null;
    const fullName =
      event.request.userAttributes["custom:full_name"] ??
      event.request.userAttributes.name ??
      null;

    if (!sub) {
      console.warn("post-confirm: no sub on event, skipping");
      return event;
    }

    // Step 1 — already linked? Pull the whole table once; the home
    // user pool is tiny and we want to do all matching in one read.
    const { data: people } = await client.models.homePerson.list();
    const all = people ?? [];

    const alreadyLinked = all.find((p) => p.cognitoUsername === sub);
    if (alreadyLinked) {
      console.log(
        `post-confirm: sub ${sub} already linked to homePerson ${alreadyLinked.id}`
      );
      return event;
    }

    const unlinked = all.filter((p) => !p.cognitoUsername);

    // Step 2 — exact email match.
    let target: Person | null = null;
    if (email) {
      const lcEmail = email.toLowerCase().trim();
      target =
        unlinked.find((p) => (p.email ?? "").toLowerCase().trim() === lcEmail) ??
        null;
    }

    // Step 3 — fuzzy name match (full_name first, then email local-part).
    if (!target) {
      const candidates: string[] = [];
      if (fullName) candidates.push(fullName);
      if (email && email.includes("@")) {
        const local = email.split("@")[0] ?? "";
        if (local) candidates.push(local);
      }
      for (const cand of candidates) {
        const hit = fuzzyNameMatch(unlinked, cand);
        if (hit) {
          target = hit;
          break;
        }
      }
    }

    if (target) {
      console.log(
        `post-confirm: linking sub ${sub} to existing homePerson ${target.id} (${target.name})`
      );
      const { errors } = await client.models.homePerson.update({
        id: target.id,
        cognitoUsername: sub,
        email,
      });
      if (errors?.length) {
        console.warn("post-confirm: link update errors:", errors);
      }
      return event;
    }

    // Step 4 — fresh row.
    const newName = (fullName ?? email?.split("@")[0] ?? "New user").trim();
    console.log(
      `post-confirm: no match for sub ${sub} / email ${email}; creating homePerson ${newName}`
    );
    const { errors: createErrors } = await client.models.homePerson.create({
      name: newName,
      cognitoUsername: sub,
      email,
      active: true,
      // groups stays empty — admin assigns via the People page.
      groups: [],
    });
    if (createErrors?.length) {
      console.warn("post-confirm: create errors:", createErrors);
    }
  } catch (err) {
    // Never block sign-up on a homePerson hiccup — the admin can fix
    // up the row later from /admin/people.
    console.error("post-confirm: unhandled error:", err);
  }
  return event;
};
