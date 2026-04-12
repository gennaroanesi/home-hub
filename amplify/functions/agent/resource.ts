import { defineFunction } from "@aws-amplify/backend";

export const homeAgent = defineFunction({
  name: "home-agent",
  // 120s headroom for wave 2's Duo Push flow: preauth (~1s) + pushAuth
  // blocking up to 60s while the user taps Approve + the normal agent
  // tool loop + Claude's final response generation. 60s was the old
  // ceiling and cut things uncomfortably close once the push landed.
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: "data",
});
