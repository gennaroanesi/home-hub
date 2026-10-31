// An operation: one action (or computed read) written once and served to
// the web app, mobile, Janet, the Muse API and the CLI. See
// docs/ops-architecture.md.

import type { z } from "zod/v4";
import type { OpContext } from "./context";

/** read: no side effects. write: changes data. sensitive: never on the API or CLI. */
export type OpAccess = "read" | "write" | "sensitive";

export interface OpDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType, N extends string = string> {
  name: N; // snake_case; doubles as the tool name and API path
  domain: string;
  description: string; // written for both an LLM and a human reading the API docs
  access: OpAccess;
  input: I;
  output: O;
  run(ctx: OpContext, input: z.output<I>): Promise<z.input<O>>;
}

export function defineOp<const N extends string, I extends z.ZodType, O extends z.ZodType>(def: OpDef<I, O, N>): OpDef<I, O, N> {
  return def;
}

/** An expected failure (bad input, not found, duplicate). The message is shown to the caller. */
export class OpError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OpError";
  }
}
