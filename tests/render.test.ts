import { describe, it, expect } from "vitest";
import { signatureLine, flattenSchema, countSchemaTokensApprox } from "../src/render/index.js";
import type { Tool } from "../src/types.js";

const weather: Tool = {
  name: "get_weather",
  description:
    "Get the current weather in a given location. Returns temperature and conditions.",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string", description: "City and state, e.g. San Francisco, CA" },
      unit: {
        type: "string",
        description: "The temperature unit to use",
        enum: ["celsius", "fahrenheit"],
      },
      days: { type: "integer", description: "Number of forecast days" },
    },
    required: ["location"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
  },
};

describe("signatureLine", () => {
  it("renders required params bare and optional params with ?", () => {
    expect(signatureLine(weather)).toBe(
      "get_weather(location,unit?:celsius|fahrenheit,days?)",
    );
  });

  it("renders a no-parameter tool as an empty arg list", () => {
    const t: Tool = { name: "get_balance", description: "d", inputSchema: { type: "object" } };
    expect(signatureLine(t)).toBe("get_balance()");
  });

  it("honours a name override for aliased tools", () => {
    expect(signatureLine(weather, "w0")).toMatch(/^w0\(/);
  });

  it("marks array item types", () => {
    const t: Tool = {
      name: "tag",
      description: "d",
      inputSchema: {
        type: "object",
        properties: { labels: { type: "array", items: { type: "string" } } },
      },
    };
    expect(signatureLine(t)).toBe("tag(labels?:string[])");
  });
});

describe("flattenSchema", () => {
  const flat = flattenSchema(weather.inputSchema);

  it("drops per-property descriptions", () => {
    expect(flat.properties!.location).toEqual({ type: "string" });
  });

  it("preserves enums, which constrain decoding", () => {
    expect(flat.properties!.unit.enum).toEqual(["celsius", "fahrenheit"]);
  });

  it("preserves the required array", () => {
    expect(flat.required).toEqual(["location"]);
  });

  it("drops $schema boilerplate", () => {
    expect(flat.$schema).toBeUndefined();
  });

  it("is strictly smaller than the input", () => {
    expect(countSchemaTokensApprox(flat)).toBeLessThan(
      countSchemaTokensApprox(weather.inputSchema),
    );
  });

  it("preserves nested object properties rather than erasing them", () => {
    const nested = flattenSchema({
      type: "object",
      properties: {
        filter: {
          type: "object",
          description: "drop me",
          properties: { field: { type: "string", description: "drop me too" } },
        },
      },
    });
    expect(nested.properties!.filter.properties.field).toEqual({ type: "string" });
  });

  it("is idempotent", () => {
    expect(flattenSchema(flat)).toEqual(flat);
  });
});
