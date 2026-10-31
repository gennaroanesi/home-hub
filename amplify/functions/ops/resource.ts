import { defineFunction } from "@aws-amplify/backend";

export const ops = defineFunction({
  name: "ops",
  // Runs any op in lib/ops for the web and mobile apps (the runOp mutation).
  // Ops that call Claude use the async GENERATING-row pattern, so AppSync's
  // 30s limit is the real ceiling here.
  timeoutSeconds: 30,
  memoryMB: 512,
  // Same stack as the other custom-mutation Lambdas, to avoid a
  // function/data circular dependency.
  resourceGroupName: "data",
});
