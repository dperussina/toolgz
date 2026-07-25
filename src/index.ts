/**
 * tool-compression — shrink LLM tool definitions without making the model dumber.
 *
 *   import { compress } from "tool-compression";
 *
 *   const c = compress(myTools, { level: 1 });
 *   const res = await client.messages.create({ ...,
 *     system: [{ type: "text", text: SYSTEM + c.systemPreamble }],
 *     tools: c.tools,
 *   });
 *   for (const block of res.content.filter(b => b.type === "tool_use")) {
 *     const r = c.resolve(block.name, block.input);
 *     if (r.kind === "call") await myDispatch(r.name, r.args);
 *   }
 */
import type {
  CompressOptions,
  CompressResult,
  Level,
  NormalizedTool,
  Resolution,
  Tool,
  MapStyle,
} from "./types.js";
import {
  countSchemaTokensApprox,
  defaultNamespaceOf,
  firstSentence,
  flattenSchema,
  normalize,
  signatureLine,
  terseDescriptor,
} from "./render/index.js";
import { validateArgs } from "./runtime/validate.js";

export * from "./types.js";
export { flattenSchema, signatureLine, countSchemaTokensApprox } from "./render/index.js";

const CODE_CHARS = "abcdefghijklmnopqrstuvwxyz";
const LEVELS: Level[] = [0, 1, 2, 3];
const MAP_STYLES: MapStyle[] = ["name", "name+required", "terse"];

const err = (message: string, recoverable = true): Resolution => ({
  kind: "error",
  message,
  recoverable,
});

/** Models sometimes emit a nested arg bag as a JSON string. Accept both. */
function asObject(v: unknown): Record<string, any> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, any>;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      if (p && typeof p === "object") return p;
    } catch {
      /* fall through */
    }
  }
  return {};
}

function defaultAlias(ns: string): string {
  return ns;
}

export function compress(
  input: Tool[],
  options: CompressOptions = {},
): CompressResult {
  const level = (options.level ?? 1) as Level;
  if (!LEVELS.includes(level)) {
    throw new Error(`unsupported level: ${level} (expected 0, 1, 2 or 3)`);
  }

  const mapStyle = options.mapStyle ?? "name";
  if (!MAP_STYLES.includes(mapStyle)) {
    throw new Error(
      `unsupported mapStyle: ${mapStyle} (expected ${MAP_STYLES.join(", ")})`,
    );
  }

  const namespaceOf = options.namespaceOf ?? defaultNamespaceOf;
  const aliasOf = options.aliasOf ?? defaultAlias;
  const searchLimit = options.searchLimit ?? 8;
  const doValidate = options.validate ?? true;

  const tools = normalize(input, namespaceOf);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const originalChars = countSchemaTokensApprox(input);

  // -- namespace grouping (levels 2 and 3) ----------------------------------
  const groups = new Map<string, NormalizedTool[]>();
  for (const t of tools) {
    if (!groups.has(t.ns)) groups.set(t.ns, []);
    groups.get(t.ns)!.push(t);
  }

  // -- level 3 code assignment ----------------------------------------------
  const codeToTool = new Map<string, NormalizedTool>();
  const toolToCode = new Map<string, string>();
  if (level === 3) {
    let ni = 0;
    for (const [, list] of groups) {
      // Two chars past 26 namespaces so codes stay unique and short.
      const prefix =
        ni < 26
          ? CODE_CHARS[ni]
          : CODE_CHARS[Math.floor(ni / 26) - 1] + CODE_CHARS[ni % 26];
      ni++;
      list.forEach((t, oi) => {
        const code = `${prefix}${oi}`;
        codeToTool.set(code, t);
        toolToCode.set(t.name, code);
      });
    }
  }

  const finish = (
    wire: unknown[],
    systemPreamble: string,
    cachePreamble: boolean,
    resolve: (n: string, a: Record<string, any>) => Resolution,
    encode: (n: string, a: Record<string, any>) => { name: string; args: Record<string, any> },
  ): CompressResult => {
    const compressedChars =
      countSchemaTokensApprox(wire) + systemPreamble.length;
    return {
      tools: wire,
      systemPreamble,
      cachePreamble,
      resolve,
      codeFor(name) {
        const c = toolToCode.get(name);
        if (!c) throw new Error(`no code for ${name} (level ${level})`);
        return c;
      },
      encodeCallForTest: encode,
      stats: {
        level,
        toolCount: tools.length,
        wireToolCount: wire.length,
        originalChars,
        compressedChars,
        savedPct:
          originalChars === 0
            ? 0
            : Math.round((1 - compressedChars / originalChars) * 1000) / 10,
      },
    };
  };

  const finalize = (t: NormalizedTool, args: Record<string, any>): Resolution => {
    if (doValidate) {
      const problem = validateArgs(t, args);
      if (problem) return err(problem);
    }
    return { kind: "call", name: t.name, args };
  };

  // -------------------------------------------------------------------------
  // Level 0 — passthrough
  // -------------------------------------------------------------------------
  if (level === 0) {
    const wire = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema,
    }));
    return finish(
      wire,
      "",
      false,
      (name, args) => {
        const t = byName.get(name);
        if (!t) return err(`No tool named "${name}".`);
        return finalize(t, asObject(args));
      },
      (name, args) => ({ name, args }),
    );
  }

  // -------------------------------------------------------------------------
  // Level 1 — signature flattening, native tools, real names
  // -------------------------------------------------------------------------
  if (level === 1) {
    const wire = tools.map((t) => {
      const d = firstSentence(t.description);
      return {
        name: t.name,
        description: d ? `${signatureLine(t)} — ${d}` : signatureLine(t),
        input_schema: flattenSchema(t.schema),
      };
    });
    return finish(
      wire,
      "",
      false,
      (name, args) => {
        const t = byName.get(name);
        if (!t) return err(`No tool named "${name}".`);
        return finalize(t, asObject(args));
      },
      (name, args) => ({ name, args }),
    );
  }

  // -------------------------------------------------------------------------
  // Level 2 — namespace collapse, semantic op names
  // -------------------------------------------------------------------------
  if (level === 2) {
    const aliasToNs = new Map<string, string>();
    const wire: unknown[] = [];
    for (const [ns, list] of groups) {
      const alias = aliasOf(ns);
      aliasToNs.set(alias, ns);
      wire.push({
        name: alias,
        description:
          `${ns} operations. Call describe_op first if unsure of an op's parameters.`,
        input_schema: {
          type: "object",
          properties: {
            op: { type: "string", enum: list.map((t) => t.op) },
            args: { type: "object" },
          },
          required: ["op", "args"],
        },
      });
    }
    wire.push({
      name: "describe_op",
      description:
        "Return the full parameter signature and description for one operation.",
      input_schema: {
        type: "object",
        properties: { ns: { type: "string" }, op: { type: "string" } },
        required: ["ns", "op"],
      },
    });

    const lookup = (nsOrAlias: string, op: string) => {
      const ns = aliasToNs.get(nsOrAlias) ?? nsOrAlias;
      return (groups.get(ns) ?? []).find((t) => t.op === op);
    };

    return finish(
      wire,
      "",
      false,
      (name, rawArgs) => {
        const args = asObject(rawArgs);
        if (name === "describe_op") {
          const t = lookup(String(args.ns), String(args.op));
          if (!t) return err(`No operation "${args.ns}.${args.op}".`);
          return {
            kind: "meta",
            name,
            result: `${signatureLine(t)} — ${t.description}`,
          };
        }
        const t = lookup(name, String(args.op));
        if (!t) {
          return err(
            `No operation "${name}.${args.op}". Call describe_op, or check the op enum on the "${name}" tool.`,
          );
        }
        return finalize(t, asObject(args.args));
      },
      (name, args) => {
        const t = byName.get(name)!;
        return { name: aliasOf(t.ns), args: { op: t.op, args } };
      },
    );
  }

  // -------------------------------------------------------------------------
  // Level 3 — minified dispatcher + opaque codes
  // -------------------------------------------------------------------------
  // Map line rendering. Default is `code name`: a prose descriptor reintroduces
  // per-tool text into the cached prefix and, measured at 60 tools, made level 3
  // LARGER than level 2. The name is the densest useful selector, and full
  // descriptions stay one q() call away.
  //
  // `name+required` adds the required parameter names — a few tokens per tool
  // against a full schema's ~400 — to reduce malformed arguments on models that
  // fill the generic argument bag poorly.
  const renderLine = (code: string, t: NormalizedTool): string => {
    if (mapStyle === "terse") return `${code} ${terseDescriptor(t.description) || t.name}`;
    if (mapStyle === "name+required") {
      const req = t.schema.required ?? [];
      return req.length ? `${code} ${t.name} ${req.join(",")}` : `${code} ${t.name}`;
    }
    return `${code} ${t.name}`;
  };
  const lines = [...codeToTool.entries()].map(([code, t]) => renderLine(code, t));
  const wire = [
    {
      name: "t",
      description:
        "Invoke a tool by its map code. Codes are listed in <toolmap> in the system prompt.",
      input_schema: {
        type: "object",
        properties: {
          f: { type: "string" },
          a: { type: "object" },
        },
        required: ["f"],
      },
    },
    {
      name: "q",
      description:
        "Expand a map code to its full name, description and parameter signature (c), or search the map by keyword (s).",
      input_schema: {
        type: "object",
        properties: { c: { type: "string" }, s: { type: "string" } },
      },
    },
  ];
  const mapLegend =
    mapStyle === "name+required"
      ? "Each line is: code name required-args. "
      : "";
  const systemPreamble = `<toolmap>\n${lines.join("\n")}\n</toolmap>\n${mapLegend}Invoke with t(f=<code>, a={…}). Use q to expand a code before calling if you are unsure of its parameters.`;

  return finish(
    wire,
    systemPreamble,
    true,
    (name, rawArgs) => {
      const args = asObject(rawArgs);
      if (name === "q") {
        if (args.c !== undefined) {
          const t = codeToTool.get(String(args.c));
          if (!t) return err(`No map code "${args.c}". Search with q(s=…).`);
          return {
            kind: "meta",
            name,
            result: `${args.c} = ${signatureLine(t, t.name)} — ${t.description}`,
          };
        }
        const q = String(args.s ?? "").toLowerCase();
        const hits = [...codeToTool.entries()]
          .filter(
            ([, t]) =>
              t.name.toLowerCase().includes(q) ||
              t.description.toLowerCase().includes(q),
          )
          .slice(0, searchLimit)
          .map(([c, t]) => `${c} = ${signatureLine(t, t.name)}`);
        return {
          kind: "meta",
          name,
          result: hits.length ? hits.join("\n") : `No matches for "${args.s}".`,
        };
      }
      if (name !== "t") {
        return err(`No tool named "${name}". Invoke tools with t(f=<code>).`);
      }
      const t = codeToTool.get(String(args.f));
      if (!t) return err(`No map code "${args.f}". Search with q(s=…).`);
      return finalize(t, asObject(args.a));
    },
    (name, args) => ({ name: "t", args: { f: toolToCode.get(name)!, a: args } }),
  );
}

export { recommendLevel } from "./recommend.js";
export type { Recommendation } from "./recommend.js";

export { forAnthropic, forOpenAI, forGemini } from "./providers/index.js";
export type { CacheTtl } from "./providers/index.js";
