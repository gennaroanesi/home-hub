// Every op, plus the adapters each surface uses: validation + dispatch,
// Claude tool definitions, and JSON Schemas for the Muse OpenAPI spec.

import { z } from "zod/v4";
import type { OpContext, OpVia } from "./context";
import { OpError, type OpDef } from "./define";
import { financeOps } from "./finance";
import { inventoryOps } from "./inventory";
import { notesOps } from "./notes";
import { wardrobeOps } from "./wardrobe";
import { weekOps } from "./week";

export const OPS = [...wardrobeOps, ...notesOps, ...inventoryOps, ...financeOps, ...weekOps] as const;

export type AnyOp = (typeof OPS)[number];
export type OpName = AnyOp["name"];
type OpByName<N extends OpName> = Extract<AnyOp, { name: N }>;
export type OpInput<N extends OpName> = z.input<OpByName<N>["input"]>;
export type OpOutput<N extends OpName> = z.input<OpByName<N>["output"]>;

const BY_NAME = new Map<string, OpDef>(OPS.map((op) => [op.name, op as unknown as OpDef]));

export function findOp(name: string): OpDef | undefined {
  return BY_NAME.get(name);
}

/** Surfaces outside the household's own apps and chat. */
const EXTERNAL: OpVia[] = ["api", "cli"];

export type OpResult = { result: unknown } | { error: string; details?: unknown };

/** Validates input, checks access for the surface, runs the op. Never throws for caller mistakes. */
export async function runOp(ctx: OpContext, name: string, rawInput: unknown): Promise<OpResult> {
  const op = findOp(name);
  if (!op) return { error: `Unknown operation: ${name}` };
  if (op.access === "sensitive" && EXTERNAL.includes(ctx.actor.via)) {
    return { error: `${name} isn't available over the API` };
  }
  const parsed = op.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
  }
  try {
    return { result: await op.run(ctx, parsed.data) };
  } catch (err) {
    if (err instanceof OpError) return { error: err.message, ...(err.details ? { details: err.details } : {}) };
    console.error(`[ops] ${name} failed`, err);
    return { error: `${name} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** runOp's AWSJSON `input` arrives as a JSON string or already parsed. */
export function parseOpInput(raw: unknown): { input: unknown } | { error: string } {
  if (raw == null) return { input: {} };
  if (typeof raw !== "string") return { input: raw };
  try {
    return { input: JSON.parse(raw) };
  } catch {
    return { error: "input must be JSON" };
  }
}

function jsonSchema(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Record<string, unknown>;
  void $schema;
  return rest;
}

export function opJsonSchemas(op: OpDef) {
  // The output is described as the op returns it, before any parsing.
  return { input: jsonSchema(op.input, "input"), output: jsonSchema(op.output, "input") };
}

/** Claude tool definition (Janet). */
export function toolDefinition(op: OpDef): { name: string; description: string; input_schema: { type: "object"; [k: string]: unknown } } {
  return { name: op.name, description: op.description, input_schema: { type: "object", ...opJsonSchemas(op).input } };
}
