// Typed calls into lib/ops for the web and mobile apps, through the runOp
// mutation. Types only come from the registry (import type), so the
// client bundle doesn't pull in zod or the op code.
//
//   const r = await callOp(client, "save_wardrobe_item", { personId, itemId, status: "KEEP" });
//   if ("error" in r) toast(r.error); else use(r.result.item);

import type { OpInput, OpName, OpOutput } from "./ops/registry";

export type OpCallResult<N extends OpName> = { result: OpOutput<N> } | { error: string; details?: unknown };

export async function callOp<N extends OpName>(
  // An Amplify data client (generateClient<Schema>()).
  client: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  name: N,
  input: OpInput<N>,
  via: "web" | "mobile" = "web",
): Promise<OpCallResult<N>> {
  const r = await client.mutations.runOp({ name, input: JSON.stringify(input), via });
  if (r.errors?.length) return { error: r.errors[0].message };
  const data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
  return (data ?? { error: "No response" }) as OpCallResult<N>;
}
