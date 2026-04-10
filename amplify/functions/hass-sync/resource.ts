import { defineFunction, secret } from "@aws-amplify/backend";

export const hassSync = defineFunction({
  name: "hass-sync",
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: "recurring",
  environment: {
    HASS_BASE_URL: secret("HASS_BASE_URL"),
    HASS_TOKEN: secret("HASS_TOKEN"),
  },
});
