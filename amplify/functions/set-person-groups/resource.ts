import { defineFunction } from "@aws-amplify/backend";

export const setPersonGroups = defineFunction({
  name: "set-person-groups",
  timeoutSeconds: 30,
  memoryMB: 256,
  // Pin to the data stack — this is a custom mutation resolver and
  // its IAM policy references the user pool ARN. Without an explicit
  // group it lands in the default function stack and creates a
  // data → function → auth cycle.
  resourceGroupName: "data",
});
