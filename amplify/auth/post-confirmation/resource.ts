import { defineFunction } from "@aws-amplify/backend";

export const postConfirmUser = defineFunction({
  name: "post-confirm-user",
  timeoutSeconds: 30,
  memoryMB: 256,
  // Pin to the auth stack — the data stack uses allow.resource(this)
  // and auth registers it as the postConfirmation trigger. Leaving
  // it in the default function stack creates an auth ↔ data ↔ function
  // cycle on deploy.
  resourceGroupName: "auth",
});
