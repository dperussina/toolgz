/**
 * The five arms.
 *
 * Deliberately a factorial ladder so each variable is isolated:
 *
 *   arm         L0 schema-flatten   L1 progressive   ns-collapse   minify
 *   control            -                  -               -           -
 *   signatures         Y                  -               -           -
 *   native             -                  Y (native)      -           -
 *   hybrid             Y                  Y (custom)      Y           -
 *   minified           Y                  Y (custom)      Y           Y
 *
 * This is a change from the first AGENTS.md sketch, which had `signatures`
 * doing L0+L1. Splitting them is what makes the result attributable: without
 * it we cannot tell whether a win came from flattening schemas or from
 * deferring them.
 */
import type {
  CompressionStrategy,
  CompiledRequest,
  ToolDef,
  Resolution,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// shared rendering helpers
// ---------------------------------------------------------------------------

/** `name(req*, opt?)` — the L0 signature line. */
export function signature(t: ToolDef, name = t.name): string {
  const props = t.input_schema.properties ?? {};
  const req = new Set(t.input_schema.required ?? []);
  const params = Object.entries(props).map(([k, v]: [string, any]) => {
    const opt = req.has(k) ? "" : "?";
    const en = v.enum ? `:${v.enum.join("|")}` : "";
    return `${k}${opt}${en}`;
  });
  return `${name}(${params.join(",")})`;
}

/** Schema with per-property descriptions and JSON Schema boilerplate stripped. */
export function flattenSchema(t: ToolDef) {
  const props = t.input_schema.properties ?? {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(props) as [string, any][]) {
    const p: any = { type: v.type };
    if (v.enum) p.enum = v.enum;
    if (v.items) p.items = v.items;
    out[k] = p;
  }
  return {
    type: "object",
    properties: out,
    required: t.input_schema.required ?? [],
  };
}

function firstSentence(s: string): string {
  const i = s.indexOf(".");
  return i === -1 ? s : s.slice(0, i);
}

/** Terse descriptor: drops articles and boilerplate, keeps the semantics. */
function terse(s: string): string {
  return firstSentence(s)
    .replace(/^(Get|Retrieve|Fetch) (details of |the |a |an )?/i, "get ")
    .replace(/\b(the|a|an|to|of|for|in|with|and)\b ?/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function findTool(tools: ToolDef[], name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}

/** Validate args against the real schema — the middleware safety net. */
export function validate(
  t: ToolDef,
  args: Record<string, any>,
): string | null {
  const req = t.input_schema.required ?? [];
  const props = t.input_schema.properties ?? {};
  for (const r of req) {
    if (args[r] === undefined || args[r] === null) {
      return `missing required parameter "${r}" for ${t.name}`;
    }
  }
  for (const k of Object.keys(args)) {
    if (!props[k]) return `unknown parameter "${k}" for ${t.name}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Arm 0 — control
// ---------------------------------------------------------------------------

export const control: CompressionStrategy = {
  id: "control",
  label: "Arm 0 · uncompressed",
  compile(tools): CompiledRequest {
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
      systemPreamble: "",
      cachePreamble: false,
    };
  },
  resolve(tools, rawName, rawArgs): Resolution {
    const t = findTool(tools, rawName);
    if (!t) return { kind: "error", message: `no such tool: ${rawName}` };
    const err = validate(t, rawArgs);
    if (err) return { kind: "error", message: err };
    return { kind: "call", name: t.name, args: rawArgs };
  },
};

// ---------------------------------------------------------------------------
// Arm C — signatures (L0 only: flatten schemas, keep everything else native)
// ---------------------------------------------------------------------------

export const signatures: CompressionStrategy = {
  id: "signatures",
  label: "Arm C · signature lines (L0)",
  compile(tools): CompiledRequest {
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: `${signature(t)} — ${firstSentence(t.description)}`,
        input_schema: flattenSchema(t),
      })),
      systemPreamble: "",
      cachePreamble: false,
    };
  },
  resolve: control.resolve,
};

// ---------------------------------------------------------------------------
// Arm D — native (L1 only: Anthropic server-side tool search + defer_loading)
// ---------------------------------------------------------------------------

/** Tools kept resident; everything else is deferred and must be searched for. */
const NATIVE_HOT = 5;

export const nativeSearch: CompressionStrategy = {
  id: "native",
  label: "Arm D · native tool search (L1)",
  compile(tools): CompiledRequest {
    const wire: any[] = [
      {
        type: "tool_search_tool_regex_20251119",
        name: "tool_search_tool_regex",
      },
    ];
    tools.forEach((t, i) => {
      wire.push({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
        // At least one tool must stay non-deferred or the API 400s.
        ...(i < NATIVE_HOT ? {} : { defer_loading: true }),
      });
    });
    return { tools: wire, systemPreamble: "", cachePreamble: false };
  },
  resolve(tools, rawName, rawArgs): Resolution {
    if (rawName === "tool_search_tool_regex") {
      return { kind: "meta", name: rawName, result: "" }; // server-side
    }
    return control.resolve(tools, rawName, rawArgs);
  },
};

// ---------------------------------------------------------------------------
// Arm B — hybrid (L0 + L1 + namespace collapse, semantic names)
// ---------------------------------------------------------------------------

const NS_ALIAS: Record<string, string> = {
  github: "gh",
  slack: "sl",
  jira: "jr",
  gdrive: "gd",
  stripe: "st",
  aws: "aws",
  notion: "nt",
  linear: "ln",
  datadog: "dd",
};

function groupByNs(tools: ToolDef[]): Map<string, ToolDef[]> {
  const m = new Map<string, ToolDef[]>();
  for (const t of tools) {
    if (!m.has(t.ns)) m.set(t.ns, []);
    m.get(t.ns)!.push(t);
  }
  return m;
}

export const hybrid: CompressionStrategy = {
  id: "hybrid",
  label: "Arm B · namespace collapse (L0+L1+ns)",
  compile(tools): CompiledRequest {
    const groups = groupByNs(tools);
    const wire: any[] = [];
    const manifest: string[] = [];

    for (const [ns, list] of groups) {
      const alias = NS_ALIAS[ns] ?? ns;
      const ops = list.map((t) => t.op);
      wire.push({
        name: alias,
        description: `${ns} operations. op ∈ {${ops.join(",")}}. Call describe_op first if unsure of args.`,
        input_schema: {
          type: "object",
          properties: {
            op: { type: "string", enum: ops },
            args: { type: "object" },
          },
          required: ["op", "args"],
        },
      });
      manifest.push(
        `${alias}: ${list.map((t) => `${t.op}(${Object.keys(t.input_schema.properties ?? {}).length})`).join(" ")}`,
      );
    }

    wire.push({
      name: "describe_op",
      description:
        "Get the full parameter signature and description for an operation.",
      input_schema: {
        type: "object",
        properties: {
          ns: { type: "string" },
          op: { type: "string" },
        },
        required: ["ns", "op"],
      },
    });

    return {
      tools: wire,
      systemPreamble: `<tools>\n${manifest.join("\n")}\n</tools>`,
      cachePreamble: true,
    };
  },
  resolve(tools, rawName, rawArgs): Resolution {
    if (rawName === "describe_op") {
      const t = tools.find(
        (x) =>
          (x.ns === rawArgs.ns || NS_ALIAS[x.ns] === rawArgs.ns) &&
          x.op === rawArgs.op,
      );
      if (!t) return { kind: "error", message: `unknown op ${rawArgs.ns}.${rawArgs.op}` };
      return {
        kind: "meta",
        name: rawName,
        result: `${signature(t)} — ${t.description}`,
      };
    }
    const ns = Object.entries(NS_ALIAS).find(([, a]) => a === rawName)?.[0] ?? rawName;
    const t = tools.find((x) => x.ns === ns && x.op === rawArgs.op);
    if (!t) return { kind: "error", message: `unknown op ${rawName}.${rawArgs.op}` };
    const args = rawArgs.args ?? {};
    const err = validate(t, args);
    if (err) return { kind: "error", message: err };
    return { kind: "call", name: t.name, args };
  },
};

// ---------------------------------------------------------------------------
// Arm A — minified (the maximal-compression design)
// ---------------------------------------------------------------------------

const CODE_CHARS = "abcdefghijklmnopqrstuvwxyz";

function codeMap(tools: ToolDef[]): Map<string, ToolDef> {
  const groups = groupByNs(tools);
  const m = new Map<string, ToolDef>();
  let ni = 0;
  for (const [, list] of groups) {
    const nsChar = CODE_CHARS[ni++ % CODE_CHARS.length];
    list.forEach((t, oi) => m.set(`${nsChar}${oi}`, t));
  }
  return m;
}

export const minified: CompressionStrategy = {
  id: "minified",
  label: "Arm A · minified codes (L0+L1+ns+minify)",
  compile(tools): CompiledRequest {
    const codes = codeMap(tools);
    const lines: string[] = [];
    for (const [code, t] of codes) lines.push(`${code} ${terse(t.description)}`);

    return {
      tools: [
        {
          name: "t",
          description: "Invoke a tool by its map code. See <m> in system prompt.",
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
            "Look up the full name, description and parameter signature for a map code, or search the map by keyword.",
          input_schema: {
            type: "object",
            properties: {
              c: { type: "string" },
              s: { type: "string" },
            },
          },
        },
      ],
      systemPreamble: `<m>\n${lines.join("\n")}\n</m>\nCall t with f=<code>. Use q to expand a code before calling if unsure of parameters.`,
      cachePreamble: true,
    };
  },
  resolve(tools, rawName, rawArgs): Resolution {
    const codes = codeMap(tools);
    if (rawName === "q") {
      if (rawArgs.c) {
        const t = codes.get(rawArgs.c);
        if (!t) return { kind: "error", message: `no code ${rawArgs.c}` };
        return {
          kind: "meta",
          name: rawName,
          result: `${rawArgs.c} = ${signature(t)} — ${t.description}`,
        };
      }
      const q = String(rawArgs.s ?? "").toLowerCase();
      const hits = [...codes.entries()]
        .filter(
          ([, t]) =>
            t.name.toLowerCase().includes(q) ||
            t.description.toLowerCase().includes(q),
        )
        .slice(0, 8)
        .map(([c, t]) => `${c} = ${signature(t)}`);
      return {
        kind: "meta",
        name: rawName,
        result: hits.length ? hits.join("\n") : "no matches",
      };
    }
    if (rawName !== "t") {
      return { kind: "error", message: `no such tool: ${rawName}` };
    }
    const t = codes.get(rawArgs.f);
    if (!t) return { kind: "error", message: `no code ${rawArgs.f}` };
    const args = rawArgs.a ?? {};
    const err = validate(t, args);
    if (err) return { kind: "error", message: err };
    return { kind: "call", name: t.name, args };
  },
};

export const ARMS: CompressionStrategy[] = [
  control,
  signatures,
  nativeSearch,
  hybrid,
  minified,
];
