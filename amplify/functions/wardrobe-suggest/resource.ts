import { defineFunction } from "@aws-amplify/backend";

export const wardrobeSuggest = defineFunction({
  name: "wardrobe-suggest",
  // One Claude call plus a handful of list queries and a weather fetch.
  timeoutSeconds: 60,
  memoryMB: 512,
  // Pin to the data stack so the AppSync custom-mutation wiring doesn't
  // create a function/data circular dep.
  resourceGroupName: "data",
});
