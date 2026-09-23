// Who counts as "the household".
//
// homePerson holds more than the household: face-tagging-only people
// (friends, extended family), invited guests with a login, and later
// kids. Household membership is the `home-users` Cognito group, mirrored
// onto homePerson.groups by the admin-only setPersonGroups mutation —
// NOT the presence of cognitoUsername (guests have one too; see the
// comment on homePerson in amplify/data/resource.ts).
//
// Use this for: assignee pickers and filters, "both"/"household" in the
// agent, calendar stripes, household-wide notifications.

export const HOUSEHOLD_GROUP = "home-users";

export interface HouseholdCandidate {
  active?: boolean | null;
  groups?: (string | null)[] | null;
}

export function isHouseholdMember(p: HouseholdCandidate): boolean {
  if (p.active === false) return false;
  return (p.groups ?? []).includes(HOUSEHOLD_GROUP);
}

export function householdMembers<P extends HouseholdCandidate>(people: P[]): P[] {
  return people.filter(isHouseholdMember);
}
