// Fallback classifier for transactions no rule matched: one Haiku call per
// sync (chunked), picking a category from the allowed list. Never throws:
// on any failure the rows stay uncategorized. Ported from gennaroanesi.com.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-5-5";
const MAX_BATCH = 60;

export type ClassifyItem = { description: string; amount: number };

function parseJsonLoose(text: string): unknown {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const m = stripped.match(/\[[\s\S]*\]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

async function classifyChunk(anthropic: Anthropic, items: ClassifyItem[], categories: string[]): Promise<(string | null)[]> {
  const allowed = new Set(categories);
  const list = items
    .map((it, i) => `[${i}] ${it.amount < 0 ? "-" : "+"}$${Math.abs(it.amount).toFixed(2)}  ${(it.description ?? "").slice(0, 120)}`)
    .join("\n");
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system:
      "You categorize a household's joint bank account transactions (mortgage, car, groceries, utilities, baby, pets and so on). For each numbered transaction pick the single best category from the ALLOWED list, using what the merchant is (e.g. 'SHELL' = Fuel, 'HEB' = Groceries) and the sign (negative = money out). If one is genuinely unrecognizable, pick the closest reasonable category. Respond with ONLY a JSON array of {\"index\": <number>, \"category\": <allowed category>} objects, one per transaction. No prose, no code fences.",
    messages: [{ role: "user", content: `ALLOWED categories: ${categories.join(", ")}\n\nTransactions:\n${list}` }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const out: (string | null)[] = items.map(() => null);
  const parsed = parseJsonLoose(text);
  if (Array.isArray(parsed)) {
    for (const row of parsed as Array<{ index?: unknown; category?: unknown }>) {
      if (typeof row?.index === "number" && row.index >= 0 && row.index < items.length && typeof row.category === "string" && allowed.has(row.category)) {
        out[row.index] = row.category;
      }
    }
  }
  return out;
}

/** Categories aligned with `items` (null = leave uncategorized). Never throws. */
export async function classifyTransactionsLLM(items: ClassifyItem[], categories: string[]): Promise<(string | null)[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || items.length === 0 || categories.length === 0) return items.map(() => null);
  const anthropic = new Anthropic({ apiKey: key });
  try {
    const results: (string | null)[] = [];
    for (let i = 0; i < items.length; i += MAX_BATCH) {
      results.push(...(await classifyChunk(anthropic, items.slice(i, i + MAX_BATCH), categories)));
    }
    return results;
  } catch (e) {
    console.error("[finance-sync] LLM classification failed:", e instanceof Error ? e.message : e);
    return items.map(() => null);
  }
}
