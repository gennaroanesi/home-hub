import { defineFunction } from "@aws-amplify/backend";

export const mergePeople = defineFunction({
  name: "merge-people",
  // Walks every model with a personId reference. Bumped timeout so a
  // long task / event table doesn't time out the merge mid-walk.
  timeoutSeconds: 120,
  memoryMB: 512,
  // Pin to the data stack — custom mutation resolver. Same rationale
  // as set-person-groups: keeps the function out of the function
  // stack so we don't create cycles with auth/data references.
  resourceGroupName: "data",
});
