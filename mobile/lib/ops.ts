// Calls into lib/ops (the same operations the web app and Janet use) through
// the runOp AppSync mutation. Raw GraphQL rather than client.mutations.runOp
// so it works whatever the bundled amplify_outputs.json knows about custom
// mutations. Types come from the registry (type-only import, erased by Metro).

import type { OpInput, OpName, OpOutput } from "../../lib/ops/registry";
import { getClient } from "./amplify";

export type OpCallResult<N extends OpName> = { result: OpOutput<N> } | { error: string; details?: unknown };

const RUN_OP = /* GraphQL */ `
  mutation RunOp($name: String!, $input: AWSJSON, $via: String) {
    runOp(name: $name, input: $input, via: $via)
  }
`;

export async function callOp<N extends OpName>(name: N, input: OpInput<N>): Promise<OpCallResult<N>> {
  try {
    const r: any = await getClient().graphql({ query: RUN_OP, variables: { name, input: JSON.stringify(input), via: "mobile" } });
    if (r.errors?.length) return { error: r.errors[0].message };
    // AWSJSON can arrive parsed, or as one or more layers of JSON string.
    let data = r.data?.runOp;
    while (typeof data === "string") data = JSON.parse(data);
    return (data ?? { error: "No response" }) as OpCallResult<N>;
  } catch (e: any) {
    return { error: e?.errors?.[0]?.message ?? e?.message ?? String(e) };
  }
}
