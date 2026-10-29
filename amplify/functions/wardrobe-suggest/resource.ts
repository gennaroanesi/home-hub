import { defineFunction } from "@aws-amplify/backend";

export const wardrobeSuggest = defineFunction({
  name: "wardrobe-suggest",
  // One Claude call plus a handful of list queries and weather fetches. Trip
  // plans can outlive AppSync's 30s limit; the Lambda keeps going and saves
  // the result on homeWardrobeTripPlan, which the page polls.
  timeoutSeconds: 120,
  memoryMB: 512,
  // Pin to the data stack so the AppSync custom-mutation wiring doesn't
  // create a function/data circular dep.
  resourceGroupName: "data",
});
