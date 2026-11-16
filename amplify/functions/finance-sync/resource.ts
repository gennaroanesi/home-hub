import { defineFunction } from "@aws-amplify/backend";

// SimpleFIN → household ledger. Runs 3×/day from an EventBridge schedule
// (backend.ts) and backs the syncFinance / listSimplefinAccounts
// mutations used by the finance pages. One SimpleFIN connection per person
// (lib/finance/simplefin-connections.ts), each an access URL in Secrets
// Manager read at run time; this Lambda only ever requests the account ids
// mapped on homeFinanceAccount, per connection.
export const financeSync = defineFunction({
  name: "finance-sync",
  timeoutSeconds: 300,
  memoryMB: 512,
  // Data stack, like the other custom-mutation Lambdas (avoids a
  // function/data circular dependency).
  resourceGroupName: "data",
});
