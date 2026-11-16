import { describe, expect, it } from "vitest";
import { DEFAULT_SIMPLEFIN_CONNECTION, SIMPLEFIN_CONNECTIONS, groupBySimplefinConnection, simplefinConnection, simplefinConnectionLabel } from "./simplefin-connections";

describe("simplefin connections", () => {
  it("has distinct keys and secrets", () => {
    expect(new Set(SIMPLEFIN_CONNECTIONS.map((c) => c.key)).size).toBe(SIMPLEFIN_CONNECTIONS.length);
    expect(new Set(SIMPLEFIN_CONNECTIONS.map((c) => c.secretName)).size).toBe(SIMPLEFIN_CONNECTIONS.length);
  });

  it("treats a missing key as the first connection and an unknown one as none", () => {
    expect(simplefinConnection(null)?.key).toBe(DEFAULT_SIMPLEFIN_CONNECTION);
    expect(simplefinConnection("")?.key).toBe(DEFAULT_SIMPLEFIN_CONNECTION);
    expect(simplefinConnection(" cristine ")?.label).toBe("Cristine");
    expect(simplefinConnection("nobody")).toBeNull();
    expect(simplefinConnectionLabel("nobody")).toBe("nobody");
  });

  it("groups mapped accounts per connection", () => {
    const g = groupBySimplefinConnection([
      { id: "a", simplefinConnection: null },
      { id: "b", simplefinConnection: "cristine" },
      { id: "c", simplefinConnection: "gennaro" },
    ]);
    expect([...g.keys()]).toEqual(["gennaro", "cristine"]);
    expect(g.get("gennaro")!.map((a) => a.id)).toEqual(["a", "c"]);
  });
});
