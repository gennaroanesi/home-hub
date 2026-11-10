import { defineFunction } from "@aws-amplify/backend";

// Sunday nudge for the week planner (lib/week-plan.ts): posts the coming
// week's headline and what needs attention to the household WhatsApp group.
export const weekReview = defineFunction({
  name: "week-review",
  timeoutSeconds: 60,
  memoryMB: 512,
  resourceGroupName: "recurring",
});
