import { defineFunction } from "@aws-amplify/backend";

export const reminderSweep = defineFunction({
  name: "reminder-sweep",
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: "recurring",
});
