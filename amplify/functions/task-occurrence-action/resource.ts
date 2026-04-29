import { defineFunction } from "@aws-amplify/backend";

export const taskOccurrenceAction = defineFunction({
  name: "task-occurrence-action",
  timeoutSeconds: 30,
  memoryMB: 256,
  // Pin to the data stack so the AppSync custom-mutation wiring doesn't
  // create a function/data circular dep.
  resourceGroupName: "data",
});
