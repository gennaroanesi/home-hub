import { defineFunction } from "@aws-amplify/backend";

export const dailySummary = defineFunction({
  name: "daily-summary",
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: "recurring",
});
