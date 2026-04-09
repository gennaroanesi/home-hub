import { defineFunction } from "@aws-amplify/backend";

export const homeAgent = defineFunction({
  name: "home-agent",
  timeoutSeconds: 60,
  memoryMB: 512,
  resourceGroupName: "data",
});
