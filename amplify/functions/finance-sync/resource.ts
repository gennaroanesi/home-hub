import { defineFunction } from "@aws-amplify/backend";

// SimpleFIN → household ledger. Runs 3×/day from an EventBridge schedule
// (backend.ts) and backs the syncFinance / listSimplefinAccounts
// mutations used by the finance pages. The access URL is the one
// gennaroanesi.com uses (Secrets Manager: gennaroanesi/simplefin); this
// Lambda only ever requests the account ids mapped on homeFinanceAccount.
export const financeSync = defineFunction({
  name: "finance-sync",
  timeoutSeconds: 300,
  memoryMB: 512,
  // Data stack, like the other custom-mutation Lambdas (avoids a
  // function/data circular dependency).
  resourceGroupName: "data",
});
