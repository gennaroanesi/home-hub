// wardrobe-suggest — backs the suggestOutfit AppSync mutation used by the
// /wardrobe page. All the logic lives in lib/wardrobe-suggest.ts so Janet's
// suggest_outfit tool behaves the same way.

import type { AppSyncResolverHandler } from "aws-lambda";
import Anthropic from "@anthropic-ai/sdk";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/wardrobe-suggest";
import type { Schema } from "../../data/resource";
import { loadSuggestContext, suggestOutfits, type Suggestion } from "../../../lib/wardrobe-suggest.js";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();
const anthropic = new Anthropic();

interface Args {
  personId: string;
  date?: string | null;
  occasion?: string | null;
  request?: string | null;
  count?: number | null;
}

interface Result {
  suggestions: Suggestion[];
  context: string | null;
  error: string | null;
}

export const handler: AppSyncResolverHandler<Args, Result> = async (event) => {
  const args = event.arguments;
  try {
    const ctx = await loadSuggestContext(client, { personId: args.personId, date: args.date });
    const { suggestions, context } = await suggestOutfits(anthropic, ctx, {
      occasion: args.occasion,
      request: args.request,
      count: args.count,
    });
    return { suggestions, context, error: suggestions.length ? null : "No outfits came back. Try again or loosen the request." };
  } catch (err) {
    console.error("[wardrobe-suggest]", err);
    return { suggestions: [], context: null, error: err instanceof Error ? err.message : String(err) };
  }
};
