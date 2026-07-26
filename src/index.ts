/**
 * toolgz — shrink LLM tool definitions without making the model dumber.
 *
 *   import { compress } from "toolgz";
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
import { nearest } from "./runtime/similar.js";

export * from "./types.js";
export { flattenSchema, signatureLine, countSchemaTokensApprox } from "./render/index.js";

const CODE_CHARS = "abcdefghijklmnopqrstuvwxyz";
const LEVELS: Level[] = [0, 1, 2, 3];
const MAP_STYLES: MapStyle[] = [
  "name",
  "name+required",
  "signature",
  "terse",
  "nocode",
  "grouped",
  "compact",
];

/**
 * Styles with no code column. For these the tool's real name is its map key, so
 * `t`, `q`, `resolve` and `codeFor` keep working unchanged — the only difference
 * is what gets written into the map and what the model passes to `f`.
 */
const CODELESS: MapStyle[] = ["nocode", "grouped"];

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

  // Default is "name+required", chosen on measurement rather than taste.
  //
  // With bare names, grok-4.5 answered acc-cross-product with ZERO tool calls
  // on 3/3 reps — a silent failure, no error, just an unaided answer. Adding
  // the required parameter names fixed it 3/3, and across all four providers
  // (360 runs) "name+required" was the only level-3 style perfect everywhere:
  // 60/60 tasks, fewer malformed arguments, fewer lookup round-trips, and
  // faster wall-clock than uncompressed on every provider. The larger map pays
  // for itself by removing a discovery turn.
  const mapStyle = options.mapStyle ?? "name+required";
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
  const codeless = CODELESS.includes(mapStyle);
  if (level === 3 && codeless) {
    // The name is the key. Nothing downstream needs to know the difference.
    for (const t of tools) {
      codeToTool.set(t.name, t);
      toolToCode.set(t.name, t.name);
    }
    if (mapStyle === "grouped") {
      // `grouped` prints `ns: op(args)`, so a model reading the map sees the bare
      // op rather than the full name. Alias it — but only where it is globally
      // unambiguous, since two namespaces can both expose e.g. `list`. Ambiguous
      // ops are simply not aliased, and the legend states the naming rule.
      const opCounts = new Map<string, number>();
      for (const t of tools) opCounts.set(t.op, (opCounts.get(t.op) ?? 0) + 1);
      for (const t of tools) {
        if (opCounts.get(t.op) === 1 && !codeToTool.has(t.op)) codeToTool.set(t.op, t);
      }
    }
  } else if (mapStyle === "compact" && level === 3) {
    // Flat two-letter index rather than the namespace-prefixed `a0` scheme.
    // Measured cheaper on every tokenizer, and the namespace prefix was already
    // redundant with the tool name printed on the same line.
    //
    // Deliberately NOT base36, which ties the best token score and is broken:
    // (26).toString(36) === "q" and (29).toString(36) === "t", so two codes would
    // collide with the dispatcher tool names and make those tools unreachable via
    // the bare-code path in resolve().
    tools.forEach((t, i) => {
      const code = CODE_CHARS[Math.floor(i / 26) % 26] + CODE_CHARS[i % 26];
      codeToTool.set(code, t);
      toolToCode.set(t.name, code);
    });
  } else if (level === 3) {
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

  /**
   * Separator-insensitive lookup for map keys.
   *
   * Observed on gpt-5.6-sol against the `grouped` style, on real MCP tools: the
   * map prints `gdrive: sheets_append_rows(...)` and the model reassembled the
   * name as `gdrive.sheets_append_rows` — a DOT, not the underscore the real name
   * uses. Every single failure in that arm was this, systematically:
   * coding.task_result, reverse.geocode, scorecard.lf_daily, get.label_data.
   *
   * Joining a namespace and an operation with `.` is the near-universal
   * convention for qualified identifiers, so the model's inference is reasonable
   * and ours was simply too strict. Rejecting it burned six turns per task and
   * cost more than the smaller map saved.
   *
   * So we compare with every separator stripped, which accepts `.`, `:`, `/`,
   * `-`, a space or nothing at all. Registered ONLY where the normalised form is
   * unambiguous: if two real tools normalise alike, neither gets an alias and the
   * caller must use an exact name.
   */
  const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normIndex = new Map<string, NormalizedTool | null>();
  const registerNorm = (key: string, t: NormalizedTool) => {
    const k = normKey(key);
    if (!k) return;
    const seen = normIndex.get(k);
    // null marks "ambiguous"; never resolve a key that could mean two tools.
    if (seen === undefined) normIndex.set(k, t);
    else if (seen && seen.name !== t.name) normIndex.set(k, null);
  };

  /** Exact map key first, then the separator-insensitive fallback. */
  const lookupMapKey = (raw: unknown): NormalizedTool | undefined => {
    const key = String(raw ?? "");
    const exact = codeToTool.get(key);
    if (exact) return exact;
    return normIndex.get(normKey(key)) ?? undefined;
  };

  if (level === 3) {
    // Real names and every map key both get an entry, so `gdrive.sheets_append_rows`,
    // `gdrive:sheets_append_rows` and `gdrivesheetsappendrows` all reach the same tool.
    for (const t of tools) registerNorm(t.name, t);
    for (const [code, t] of codeToTool) registerNorm(code, t);
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
    // Full signature: optional params included, so the model rarely needs q().
    if (mapStyle === "signature") return `${code} ${signatureLine(t)}`;
    if (mapStyle === "name+required") {
      const req = t.schema.required ?? [];
      return req.length ? `${code} ${t.name} ${req.join(",")}` : `${code} ${t.name}`;
    }
    // A space costs fewer tokens than a comma at the same character count.
    if (mapStyle === "compact") {
      const req = t.schema.required ?? [];
      return req.length ? `${code} ${t.name} ${req.join(" ")}` : `${code} ${t.name}`;
    }
    // `nocode`: the code already *is* the name, so emitting both would restore
    // the duplication this style exists to remove.
    if (mapStyle === "nocode") {
      const req = t.schema.required ?? [];
      return req.length ? `${t.name} ${req.join(",")}` : t.name;
    }
    return `${code} ${t.name}`;
  };

  // `grouped` factors the shared namespace prefix out of every line: real MCP
  // names repeat it on each tool (google_maps_*), and at 100 tools that repetition
  // measured ~22% of the map's tokens.
  const groupedLines = (): string[] =>
    [...groups].map(([ns, list]) => {
      const req = (t: NormalizedTool) => t.schema.required ?? [];
      // A group of one is never worth factoring, and for a name with no separator
      // it is actively wrong: defaultNamespaceOf sets ns === op === name, so the
      // line renders "customers: customers()" while the legend promises the full
      // name is namespace_op. The model then builds "customers_customers", which
      // does not exist. Observed on the real corpus: customers, fifo, intransit
      // were all unreachable via the documented rule.
      //
      // So singletons are emitted as complete names, and the legend says a line
      // with no colon is already a full name.
      if (list.length < 2) {
        return list
          .map((t) => (req(t).length ? `${t.name} ${req(t).join(",")}` : t.name))
          .join("\n");
      }
      const ops = list
        .map((t) => (req(t).length ? `${t.op}(${req(t).join(",")})` : `${t.op}()`))
        .join(" ");
      return `${ns}: ${ops}`;
    });

  const lines =
    mapStyle === "grouped"
      ? groupedLines()
      : // Codeless styles alias extra keys into codeToTool, so iterate the tools
        // themselves to avoid emitting a line per alias.
        codeless
        ? tools.map((t) => renderLine(t.name, t))
        : [...codeToTool.entries()].map(([code, t]) => renderLine(code, t));
  const wire = [
    {
      name: "t",
      description: codeless
        ? "Invoke a tool by its name. Names are listed in <toolmap> in the system prompt."
        : "Invoke a tool by its map code. Codes are listed in <toolmap> in the system prompt.",
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
      description: codeless
        ? "Expand a tool name to its full description and parameter signature (c), or search the map by keyword (s)."
        : "Expand a map code to its full name, description and parameter signature (c), or search the map by keyword (s).",
      input_schema: {
        type: "object",
        properties: { c: { type: "string" }, s: { type: "string" } },
      },
    },
  ];
  const mapLegend =
    mapStyle === "name+required"
      ? "Each line is: code name required-args. "
      : mapStyle === "compact"
        ? "Each line is: code name required-args, space separated. "
      : mapStyle === "signature"
        ? "Each line is: code name(args), where ? marks optional. "
        : mapStyle === "nocode"
          ? "Each line is: name required-args. "
          : mapStyle === "grouped"
            ? "Lines are grouped by namespace: `namespace: op(required-args) …`, and a tool's full name is namespace_op. A line with no colon is already a complete tool name. "
            : "";
  // Codeless styles must tell the model to pass the name, not a code, or it will
  // hunt for a code column that is not there.
  const invokeHint = codeless
    ? "Invoke with t(f=<name>, a={…}). Use q to expand a name before calling if you are unsure of its parameters."
    : "Invoke with t(f=<code>, a={…}). Use q to expand a code before calling if you are unsure of its parameters.";
  const systemPreamble = `<toolmap>\n${lines.join("\n")}\n</toolmap>\n${mapLegend}${invokeHint}`;

  return finish(
    wire,
    systemPreamble,
    true,
    (rawName, rawArgs) => {
      let name = rawName;
      let args = asObject(rawArgs);

      // Observed on grok-4.5 across every level-3 style, including the shipped
      // default: the model routes the lookup tool through the dispatcher, calling
      // t(f="q", a={s:"lost freight"}) instead of q(s="lost freight").
      //
      // The preamble invites this — it says "Invoke with t(f=<name>, a={…})" and
      // then "Use q to expand a name", which reads as "everything goes through t,
      // including q". Rejecting it cost a turn each time, and `t`/`q` are our own
      // reserved names, so the intent is unambiguous: nothing else could be meant.
      if (name === "t" && (args.f === "q" || args.f === "t")) {
        const nested = asObject(args.a);
        const flat = Object.fromEntries(
          Object.entries(args).filter(([k]) => k !== "f" && k !== "a"),
        );
        name = String(args.f);
        args = Object.keys(nested).length ? nested : flat;
      }

      if (name === "q") {
        if (args.c !== undefined) {
          const t = lookupMapKey(args.c);
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
      // Models sometimes call the map code as the tool name — observed on
      // claude-opus-5: name="b5", args={f:"b5", a:"{…}"}. Codes are unique and
      // cannot collide with `t` or `q`, so this form is unambiguous and
      // accepting it removes a whole class of wasted turn.
      const viaCode = name !== "t" && name !== "q" ? lookupMapKey(name) : undefined;
      if (!viaCode && name !== "t") {
        return err(`No tool named "${name}". Invoke tools with t(f=<code>).`);
      }

      const t = viaCode ?? lookupMapKey(args.f);
      if (!t) {
        const guess = nearest(String(args.f ?? ""), [...codeToTool.keys()]);
        return err(
          `No map code "${args.f}". Search with q(s=…).` +
            (guess ? ` Did you mean "${guess}"? Use it exactly as written in <toolmap>.` : ""),
        );
      }

      // Args may arrive nested under `a`, or flat alongside `f`. Prefer `a`
      // when present rather than merging, so there is one source of truth.
      const nested = asObject(args.a);
      const flat = Object.fromEntries(
        Object.entries(args).filter(([k]) => k !== "f" && k !== "a"),
      );
      const callArgs =
        args.a !== undefined && Object.keys(nested).length
          ? nested
          : Object.keys(flat).length
            ? flat
            : nested;
      return finalize(t, callArgs);
    },
    (name, args) => ({ name: "t", args: { f: toolToCode.get(name)!, a: args } }),
  );
}

export { recommendLevel } from "./recommend.js";
export type { Recommendation } from "./recommend.js";

export { forAnthropic, forOpenAI, forOpenAIResponses, forGemini } from "./providers/index.js";
export type { CacheTtl } from "./providers/index.js";
