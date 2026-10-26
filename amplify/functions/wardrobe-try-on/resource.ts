import { defineFunction } from "@aws-amplify/backend";
export const wardrobeTryOn = defineFunction({
  name: "wardrobe-try-on",
  timeoutSeconds: 300,
  memoryMB: 1024,
  resourceGroupName: "data",
});
