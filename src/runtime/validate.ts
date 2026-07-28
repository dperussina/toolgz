import type { NormalizedTool } from "../types.js";
import { nearest } from "./similar.js";

/**
 * Validate arguments against the *original* schema before dispatch.
 *
 * This matters most at levels 2, 3 and 4: routing calls through a generic
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
  // Conditionally-required keys count as required once their condition holds.
  const required: string[] = [...(schema.required ?? []), ...conditionallyRequired(schema, args)];
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

/**
 * The `if/then` subset that expresses "this operation needs a confirmation flag".
 *
 * Reported by a team whose 60-tool registry has 16 confirmation-gated operations. Their
 * contract lived in description prose, which every level above 0 strips, so the model
 * stopped sending the flag. The durable place for it is the schema — except a compound
 * tool cannot put `_confirmed` in `required[]` without breaking every benign call:
 * `manage_dashboard{operation:"list"}` would start erroring.
 *
 * So this supports exactly the shape that solves it, and no more:
 *
 *   allOf: [{ if: { properties: { operation: { const: "delete" } } },
 *             then: { required: ["_confirmed"] } }]
 *
 * `const` and `enum` are both honoured on the condition, `if`/`then` may sit at the top
 * level or inside `allOf`, and multiple branches accumulate. Anything else — `else`,
 * nested conditionals, `not`, `dependentRequired` — is deliberately ignored rather than
 * half-implemented, because a validator that silently mis-handles a contract is worse
 * than one that visibly does not implement it. Documented in the README as such.
 *
 * Note this enforces the contract; it does not make it *visible* to the model. At level 3
 * nothing schema-encoded reaches the model at all, so the policy still belongs in the
 * system prompt. This is the backstop, not the mechanism.
 */
function conditionallyRequired(schema: any, args: Record<string, any>): string[] {
  const branches: any[] = [];
  if (schema?.if) branches.push(schema);
  if (Array.isArray(schema?.allOf)) {
    for (const entry of schema.allOf) if (entry?.if) branches.push(entry);
  }

  const out: string[] = [];
  for (const branch of branches) {
    if (!matches(branch.if, args)) continue;
    const req = branch.then?.required;
    if (Array.isArray(req)) out.push(...req.filter((k) => typeof k === "string"));
  }
  return out;
}

/** True when every property the condition names agrees with the supplied arguments. */
function matches(cond: any, args: Record<string, any>): boolean {
  const props = cond?.properties;
  if (!props || typeof props !== "object") return false;
  const entries = Object.entries(props as Record<string, any>);
  if (!entries.length) return false;
  return entries.every(([key, spec]) => {
    const value = args[key];
    if (value === undefined) return false;
    if (spec && "const" in spec) return value === spec.const;
    if (spec && Array.isArray(spec.enum)) return spec.enum.includes(value);
    // A condition we cannot evaluate must not be treated as satisfied.
    return false;
  });
}
