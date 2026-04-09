import { defineFunction } from "@aws-amplify/backend";

export const homeScheduler = defineFunction({
  name: "home-scheduler",
  timeoutSeconds: 30,
  resourceGroupName: "scheduler",
});
