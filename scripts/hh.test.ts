import { describe, expect, it } from "vitest";
import { coerce, needsConfirmation, operationsFrom, parseArgs, type Operation } from "./hh";

const save: Operation = {
  operationId: "save_wardrobe_item",
  "x-access": "write",
  requestBody: {
    content: {
      "application/json": {
        schema: {
          properties: {
            itemId: { type: "string" },
            styleCode: { type: "string" },
            price: { anyOf: [{ type: "number" }, { type: "null" }] },
            allowDuplicate: { type: "boolean" },
            imageUrls: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

describe("hh", () => {
  it("reads the /tools/* operations out of the spec", () => {
    const ops = operationsFrom({ paths: { "/tools/save_wardrobe_item": { post: save }, "/ask": { post: { operationId: "ask" } } } });
    expect(Array.from(ops.keys())).toEqual(["save_wardrobe_item"]);
  });

  it("types flags from the schema, collects arrays and merges --json", () => {
    const { input, yes } = parseArgs(
      ["--styleCode", "0042", "--price=135", "--allowDuplicate", "true", "--imageUrls", "https://a", "--imageUrls", '["https://b"]', "--json", '{"itemId":"x"}'],
      save,
    );
    expect(yes).toBe(false);
    expect(input).toEqual({ styleCode: "0042", price: 135, allowDuplicate: true, imageUrls: ["https://a", "https://b"], itemId: "x" });
    expect(parseArgs(["--price", "null", "-y"], save)).toEqual({ input: { price: null }, yes: true });
  });

  it("rejects unknown parameters and missing values", () => {
    expect(() => parseArgs(["--nope", "1"], save)).toThrow(/no parameter "nope"/);
    expect(() => parseArgs(["--itemId"], save)).toThrow(/needs a value/);
    expect(() => parseArgs(["itemId"], save)).toThrow(/Unexpected argument/);
  });

  it("keeps text that looks like JSON as text when the field is a string", () => {
    expect(coerce("true", { type: "string" })).toBe("true");
    expect(coerce("12", { anyOf: [{ type: "number" }, { type: "null" }] })).toBe(12);
    expect(coerce("hello", undefined)).toBe("hello");
  });

  it("dry-runs everything but reads", () => {
    expect(needsConfirmation({ operationId: "a", "x-access": "read" })).toBe(false);
    expect(needsConfirmation({ operationId: "b", "x-access": "write" })).toBe(true);
    expect(needsConfirmation({ operationId: "c", "x-access": "unknown" })).toBe(true);
    expect(needsConfirmation({ operationId: "d" })).toBe(true);
  });
});
