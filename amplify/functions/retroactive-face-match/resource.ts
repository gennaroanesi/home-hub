import { defineFunction } from "@aws-amplify/backend";

export const retroactiveFaceMatch = defineFunction({
  name: "retroactive-face-match",
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: "data",
});
