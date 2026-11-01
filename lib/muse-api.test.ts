import { describe, expect, it } from "vitest";
import { buildOpenApiSpec, missingRequired, type MuseTool } from "./muse-api";

const op: MuseTool = {
  name: "list_wardrobe",
  description: "List items. More detail here.",
  input_schema: { type: "object", properties: { status: { type: "string" } } },
  output_schema: { type: "object", properties: { count: { type: "number" } } },
  access: "read",
};
const legacy: MuseTool = { name: "create_task", input_schema: { type: "object", properties: {}, required: ["title"] } };

describe("buildOpenApiSpec", () => {
  const spec = buildOpenApiSpec([op, legacy], "https://home.example/api/muse") as any;

  it("types an op's result and marks its access", () => {
    const post = spec.paths["/tools/list_wardrobe"].post;
    expect(post["x-access"]).toBe("read");
    expect(post.summary).toBe("List items.");
    expect(post.responses["200"].content["application/json"].schema).toEqual({
      type: "object",
      properties: { result: op.output_schema },
      required: ["result"],
    });
  });

  it("leaves legacy tools untyped and of unknown access", () => {
    const post = spec.paths["/tools/create_task"].post;
    expect(post["x-access"]).toBe("unknown");
    expect(post.responses["200"].content["application/json"].schema.properties.result).toEqual({});
  });

  it("serves the bearer-protected server URL and the upload route", () => {
    expect(spec.servers).toEqual([{ url: "https://home.example/api/muse" }]);
    expect(spec.paths["/uploads"].post.description).toMatch(/save_wardrobe_item/);
  });
});

describe("missingRequired", () => {
  it("lists required fields that are absent or null", () => {
    expect(missingRequired(legacy, {})).toEqual(["title"]);
    expect(missingRequired(legacy, { title: null })).toEqual(["title"]);
    expect(missingRequired(legacy, { title: "x" })).toEqual([]);
  });
});
