// week-review — Sunday 17:00 America/Chicago (EventBridge, amplify/backend.ts).
// Builds the coming week with the same loader get_week_plan uses and queues
// a WhatsApp message to the household group pointing at /week. Skips weeks
// already marked reviewed. Invoke with { "dryRun": true } to only log it.

import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/week-review";
import type { Schema } from "../../data/resource";
import { loadWeekPlan } from "../../../lib/ops/week.js";
import { weekNudgeText } from "../../../lib/week-plan.js";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

const APP_URL = process.env.APP_URL ?? "https://home.cristinegennaro.com";

export const handler = async (event: { dryRun?: boolean; weekStart?: string } = {}) => {
  const plan = await loadWeekPlan(client, event.weekStart);
  if (plan.review?.reviewedAt) {
    console.log(`[week-review] ${plan.weekStart} already reviewed by ${plan.review.reviewedBy ?? "someone"}; no nudge`);
    return { skipped: "reviewed", weekStart: plan.weekStart };
  }
  const text = weekNudgeText(plan, `${APP_URL}/week?week=${plan.weekStart}`);
  console.log(`[week-review] ${plan.weekStart}\n${text}`);
  if (event.dryRun) return { dryRun: true, weekStart: plan.weekStart, text };
  const { data, errors } = await client.models.homeOutboundMessage.create({
    channel: "WHATSAPP",
    target: "GROUP",
    text,
    status: "PENDING",
    kind: "week_review",
  });
  if (errors?.length) throw new Error(errors[0].message);
  return { weekStart: plan.weekStart, messageId: data?.id };
};
