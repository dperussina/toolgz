import type { NormalizedTool } from "../types.js";

/**
 * Validate arguments against the *original* schema before dispatch.
 *
 * This matters most at levels 2 and 3: routing calls through a generic
 * dispatcher moves argument checking out of the provider's constrained
 * sampler and into here. Error strings are written for the model to read —
 * they name the tool and the offending parameter so it can retry correctly
 * rather than guessing.
 */
export function validateArgs(
  tool: NormalizedTool,
  args: Record<string, any>,
): string | null {
  const schema = tool.schema ?? {};
  const props: Record<string, any> = schema.properties ?? {};
  const required: string[] = schema.required ?? [];

  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      return `Missing required parameter "${key}" for ${tool.name}. Required: ${required.join(", ")}.`;
    }
  }

  const known = Object.keys(props);
  if (known.length) {
    for (const key of Object.keys(args)) {
      if (!props[key]) {
        return `Unknown parameter "${key}" for ${tool.name}. Accepted: ${known.join(", ")}.`;
      }
    }
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
    return `Invalid value for "${key}" on ${toolName}: expected one of ${spec.enum.join(", ")}.`;
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
