import type { NormalizedTool } from "../types.js";
import { nearest } from "./similar.js";

/**
 * Validate arguments against the *original* schema before dispatch.
 *
 * This matters most at levels 2 and 3: routing calls through a generic
 * dispatcher moves argument checking out of the provider's constrained
 * sampler and into here. Error strings are written for the model to read —
 * they name the tool, the offending parameter, and where possible the exact
 * fix, because a vague error costs another turn and another round of thinking.
 */
export function validateArgs(
  tool: NormalizedTool,
  args: Record<string, any>,
): string | null {
  const schema = tool.schema ?? {};
  const props: Record<string, any> = schema.properties ?? {};
  const required: string[] = schema.required ?? [];
  const known = Object.keys(props);
  const supplied = Object.keys(args);

  // Keys the caller sent that the schema does not define. Computed first so a
  // missing-required error can point at the likely rename.
  const unknown = known.length ? supplied.filter((k) => !props[k]) : [];

  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      // The `query` → `q` case: a required key is absent and an undefined key
      // was supplied that looks like it. Suggest, never silently remap.
      const guess = nearest(key, unknown);
      const hint = guess
        ? ` You passed "${guess}" — did you mean "${key}"? Rename it.`
        : "";
      return (
        `Missing required parameter "${key}" for ${tool.name}.` +
        ` Required: ${required.join(", ")}.${hint}`
      );
    }
  }

  if (unknown.length) {
    const key = unknown[0];
    const guess = nearest(key, known);
    const hint = guess ? ` Did you mean "${guess}"?` : "";
    return (
      `Unknown parameter "${key}" for ${tool.name}.` +
      ` Accepted: ${known.join(", ")}.${hint}`
    );
  }

  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    if (!spec) continue;
    const problem = checkType(tool.name, key, spec, value);
    if (problem) return problem;
  }

  return null;
}

function checkType(
  toolName: string,
  key: string,
  spec: any,
  value: any,
): string | null {
  if (spec.enum && !spec.enum.includes(value)) {
    // Case drift ("approve" for "APPROVE") is common; show the exact spelling
    // rather than only the list, so the retry is mechanical.
    const ci =
      typeof value === "string"
        ? spec.enum.find(
            (e: any) => typeof e === "string" && e.toLowerCase() === value.toLowerCase(),
          )
        : undefined;
    const hint = ci ? ` Use exactly "${ci}".` : "";
    return (
      `Invalid value for "${key}" on ${toolName}:` +
      ` expected one of ${spec.enum.join(", ")}.${hint}`
    );
  }
  switch (spec.type) {
    case "string":
      if (typeof value !== "string")
        return `Parameter "${key}" on ${toolName} must be a string.`;
      break;
    case "integer":
      if (!Number.isInteger(value))
        return `Parameter "${key}" on ${toolName} must be an integer.`;
      break;
    case "number":
      if (typeof value !== "number")
        return `Parameter "${key}" on ${toolName} must be a number.`;
      break;
    case "boolean":
      if (typeof value !== "boolean")
        return `Parameter "${key}" on ${toolName} must be a boolean.`;
      break;
    case "array":
      if (!Array.isArray(value))
        return `Parameter "${key}" on ${toolName} must be an array.`;
      break;
    case "object":
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return `Parameter "${key}" on ${toolName} must be an object.`;
      break;
  }
  return null;
}
