import { defineFunction } from "@aws-amplify/backend";

export const recurringTasks = defineFunction({
  name: "recurring-tasks",
  timeoutSeconds: 60,
  resourceGroupName: "recurring",
});
