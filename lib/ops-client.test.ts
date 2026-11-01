import { describe, expect, it } from "vitest";
import { callOp } from "./ops-client";

function client(response: { data?: unknown; errors?: { message: string }[] }) {
  const calls: unknown[] = [];
  return { calls, client: { mutations: { runOp: async (args: unknown) => (calls.push(args), response) } } };
}

describe("callOp", () => {
  it("sends the input as JSON and unwraps the result", async () => {
    const { client: c, calls } = client({ data: JSON.stringify({ result: { count: 1 } }) });
    const r = await callOp(c, "list_wardrobe", { personId: "p1" });
    expect(calls).toEqual([{ name: "list_wardrobe", input: '{"personId":"p1"}', via: "web" }]);
    expect(r).toEqual({ result: { count: 1 } });
  });

  it("passes op errors and GraphQL errors through as { error }", async () => {
    expect(await callOp(client({ data: { error: "nope", details: { x: 1 } } }).client, "list_wardrobe", {}, "mobile")).toEqual({
      error: "nope",
      details: { x: 1 },
    });
    expect(await callOp(client({ errors: [{ message: "Unauthorized" }] }).client, "list_wardrobe", {})).toEqual({ error: "Unauthorized" });
    expect(await callOp(client({ data: null }).client, "list_wardrobe", {})).toEqual({ error: "No response" });
  });
});
