import { defineFunction, secret } from "@aws-amplify/backend";

export const dailySummary = defineFunction({
  name: "daily-summary",
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: "recurring",
  environment: {
    // Used for the optional HA healthcheck when composing the morning
    // summary. Summary still works fine if these are unset — it just
    // skips the home-status line.
    HASS_BASE_URL: secret("HASS_BASE_URL"),
    HASS_TOKEN: secret("HASS_TOKEN"),
  },
});
