import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "../../src/tools.js";

describe("zodToJsonSchema（手写转换器）", () => {
  it("string 带 min/max", () => {
    expect(zodToJsonSchema(z.string().min(2).max(10))).toEqual({
      type: "string",
      minLength: 2,
      maxLength: 10,
    });
  });

  it("enum → { type: string, enum }", () => {
    expect(zodToJsonSchema(z.enum(["a", "b"]))).toEqual({ type: "string", enum: ["a", "b"] });
  });

  it("number 带 minimum/maximum", () => {
    expect(zodToJsonSchema(z.number().min(1).max(5))).toEqual({
      type: "number",
      minimum: 1,
      maximum: 5,
    });
  });

  it("array → items 递归", () => {
    expect(zodToJsonSchema(z.array(z.string()))).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("object：required 只含必填字段，optional 不进 required", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
      tags: z.array(z.string()),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["name", "tags"],
    });
  });

  it("description 透传", () => {
    expect(zodToJsonSchema(z.string().describe("a path"))).toEqual({
      type: "string",
      description: "a path",
    });
  });

  it("literal → const", () => {
    expect(zodToJsonSchema(z.literal("read"))).toEqual({ type: "string", const: "read" });
  });

  it("union → anyOf", () => {
    expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
  });
});
