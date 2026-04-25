import { defineFunction } from "@aws-amplify/backend";

export const icsSync = defineFunction({
  name: "ics-sync",
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: "recurring",
});
