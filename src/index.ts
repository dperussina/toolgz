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
  CompressStats,
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
import { POLICY, BROKEN, CONSERVATIVE_DEFAULT } from "./policy.generated.js";
import type { PolicyEntry, BrokenEntry } from "./policy.generated.js";

export * from "./types.js";
export { flattenSchema, signatureLine, countSchemaTokensApprox } from "./render/index.js";
// Exported so consumers can see WHY a style was chosen. The generated file is not in
// the published tarball (only dist/ ships), so without this the policy is a black box
// and the README could point at something a user cannot read.
export { POLICY, BROKEN, CONSERVATIVE_DEFAULT } from "./policy.generated.js";
export type { PolicyEntry, BrokenEntry, Objective } from "./policy.generated.js";

const CODE_CHARS = "abcdefghijklmnopqrstuvwxyz";
const LEVELS: Level[] = [0, 1, 2, 3, 4];
/** Exported so docs guards derive the valid set instead of keeping their own copy. */
export const MAP_STYLES: MapStyle[] = [
  "name+required",
  "explicit",
  "signature",
];

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



/**
 * Choose the level-3 map style, and report anything it had to substitute.
 *
 * Pure and exported so the disallow path is testable against synthetic tables. It
 * used to be inline in `compress()`, which meant it could only be exercised through
 * a real BROKEN entry — and once the one unsafe style was removed from the library
 * there were none, leaving the safety valve untested.
 *
 * Order: an explicit request wins unless measured unsafe for that model; then the
 * measured policy for (model, objective); then the conservative default.
 */
export function selectMapStyle(
  options: Pick<CompressOptions, "mapStyle" | "model" | "objective">,
  policy: readonly PolicyEntry[] = POLICY,
  broken: readonly BrokenEntry[] = BROKEN,
): { mapStyle: MapStyle; requestedMapStyle?: MapStyle; fallbackReason?: string } {
  const objective = options.objective ?? "occupancy";

  if (options.mapStyle) {
    const unsafe = options.model
      ? broken.find((b) => b.model === options.model && b.mapStyle === options.mapStyle)
      : undefined;
    if (!unsafe) return { mapStyle: options.mapStyle };
    // Owner decision: disallow a measured-unsafe pair and fall back, rather than
    // honour it with a warning. Reported, never silent.
    return {
      mapStyle: CONSERVATIVE_DEFAULT,
      requestedMapStyle: options.mapStyle,
      fallbackReason:
        `mapStyle "${options.mapStyle}" is measured unsafe on ${unsafe.model}: ` +
        `${unsafe.reason} (n=${unsafe.n}, sweep ${unsafe.sweep}). ` +
        `Using "${CONSERVATIVE_DEFAULT}" instead.`,
    };
  }

  if (options.model) {
    const hit = policy.find((e) => e.model === options.model && e.objective === objective);
    return { mapStyle: hit ? hit.mapStyle : CONSERVATIVE_DEFAULT };
  }
  return { mapStyle: CONSERVATIVE_DEFAULT };
}

export function compress(
  input: Tool[],
  options: CompressOptions = {},
): CompressResult {
  const level = (options.level ?? 1) as Level;
  if (!LEVELS.includes(level)) {
    throw new Error(`unsupported level: ${level} (expected 0, 1, 2, 3 or 4)`);
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
  const {
    mapStyle,
    requestedMapStyle,
    fallbackReason,
  } = selectMapStyle(options, POLICY, BROKEN);
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
  // Level 4 is level 3 with a compiled map, so it shares code assignment, the resolver
  // and the name index. Only the rendering of the map differs.
  if (level >= 3) {

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
   * Separator-insensitive lookup for level-3 map keys.
   *
   * Observed on gpt-5.6-sol against real MCP tools: the model reassembled a
   * namespaced name with a DOT where the real tool uses an underscore —
   * `gdrive.sheets_append_rows`, `coding.task_result`, `reverse.geocode`. Joining a
   * namespace and an operation with `.` is the ordinary convention for qualified
   * identifiers, so the inference is reasonable and ours was simply too strict.
   * Rejecting it burned six turns per task.
   *
   * Keys are therefore compared with every separator stripped, which accepts `.`,
   * `:`, `/`, `-`, a space, or nothing. Registered ONLY where the normalised form
   * is unambiguous: if two tools normalise alike neither is aliased and the exact
   * name is required, so this can never silently dispatch the wrong tool.
   */
  const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normIndex = new Map<string, NormalizedTool | null>();
  const registerNorm = (key: string, t: NormalizedTool) => {
    const k = normKey(key);
    if (!k) return;
    const seen = normIndex.get(k);
    if (seen === undefined) normIndex.set(k, t);          // first claim
    else if (seen && seen.name !== t.name) normIndex.set(k, null); // ambiguous
  };
  if (level >= 3) {
    for (const t of tools) registerNorm(t.name, t);
    for (const [code, t] of codeToTool) registerNorm(code, t);
  }
  /** Exact map key first, then the separator-insensitive fallback. */
  const lookupMapKey = (raw: unknown): NormalizedTool | undefined => {
    const key = String(raw ?? "");
    return codeToTool.get(key) ?? normIndex.get(normKey(key)) ?? undefined;
  };

  const finish = (
    wire: unknown[],
    systemPreamble: string,
    cachePreamble: boolean,
    resolve: (n: string, a: Record<string, any>) => Resolution,
    encode: (n: string, a: Record<string, any>) => { name: string; args: Record<string, any> },
    extra: Partial<CompressStats> = {},
  ): CompressResult => {
    const compressedChars =
      countSchemaTokensApprox(wire) + systemPreamble.length;

    // `savedPct` is a CHARACTER saving, deliberately.
    //
    // 0.2.7 tried to make it a token estimate by dividing each side by a chars-per-token
    // ratio calibrated against count_tokens. That was a mistake, and measurement caught
    // it: providers charge a fixed framing cost per tool definition that character
    // counting cannot see. At 149 tools it amortises away, at 2 tools it dominates — the
    // ratio approach was off by 44% on a 2-tool level-1 block while being within 1% at
    // 149. No local character-based calculation can span that range.
    //
    // The plain character ratio is the smaller and more predictable error: it runs a few
    // points optimistic (−7.7% chars against −4.9% real tokens on a 2-tool set; 45.2%
    // against 39.2% on 149 real tools). So it is reported as what it is, and the docs say
    // to measure with your provider's counter for anything you publish.
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
        mapStyle,
        requestedMapStyle:
          requestedMapStyle && requestedMapStyle !== mapStyle ? requestedMapStyle : undefined,
        fallbackReason,
        toolCount: tools.length,
        wireToolCount: wire.length,
        originalChars,
        compressedChars,
        savedPct:
          originalChars === 0
            ? 0
            : Math.round((1 - compressedChars / originalChars) * 1000) / 10,
        ...extra,
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
    const withSig = options.signaturePrefix ?? true;
    const wire = tools.map((t) => {
      const d = firstSentence(t.description);
      // With no description the signature is the only content there is, so it stays
      // regardless — an empty description would leave the model nothing to read.
      return {
        name: t.name,
        description: withSig || !d ? (d ? `${signatureLine(t)} — ${d}` : signatureLine(t)) : d,
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
  const compiled = options.compiled ?? {};
  let uncompiled = 0;
  // Levels 3 and 4 — minified dispatcher, with a mechanical or a compiled map
  // -------------------------------------------------------------------------
  const isCompiled = level === 4;
  if (isCompiled && !Object.keys(compiled).length) {
    throw new Error(
      "level 4 needs a compiled map. Generate one with `npx toolgz compile` or " +
        "compileTools(tools, { complete }), then pass it as { compiled }. " +
        "Every other level is derived from your schemas and needs nothing.",
    );
  }
  // Map line rendering. Default is `code name`: a prose descriptor reintroduces
  // per-tool text into the cached prefix and, measured at 60 tools, made level 3
  // LARGER than level 2. The name is the densest useful selector, and full
  // descriptions stay one q() call away.
  //
  // `name+required` adds the required parameter names — a few tokens per tool
  // against a full schema's ~400 — to reduce malformed arguments on models that
  // fill the generic argument bag poorly.
  const renderLine = (code: string, t: NormalizedTool): string => {
    const req = t.schema.required ?? [];
    // Full signature: optional params included, so the model rarely needs q().
    if (isCompiled) {
      const line = compiled[t.name];
      if (line) return line;
      // No compiled entry: emit something correct rather than omitting the tool, and make
      // the mixture visible in stats instead of silent.
      uncompiled++;
      return `def ${t.name}(${(t.schema.required ?? []).join(",")}):"(not compiled)"`;
    }
    if (mapStyle === "signature") return `${code} ${signatureLine(t)}`;
    if (req.length) return `${code} ${t.name} ${req.join(",")}`;
    // No required parameters. `explicit` says so, because a bare name is
    // indistinguishable from a tool whose parameters were omitted, and the model
    // spends a lookup finding out it could have just called it.
    return mapStyle === "explicit" ? `${code} ${t.name} ()` : `${code} ${t.name}`;
  };

  const lines = [...codeToTool.entries()].map(([code, t]) => renderLine(code, t));

  /**
   * How much of the map carries nothing but a name.
   *
   * Derived from the same `renderLine` inputs rather than by parsing the rendered text,
   * so the number cannot disagree with the map it describes. The "body" is the line with
   * the code and the tool name removed — for `name+required` that is the required-args
   * list, for `signature` the parenthesised signature.
   */
  const lineBody = (t: NormalizedTool): string => {
    const req = t.schema.required ?? [];
    if (isCompiled) {
      // Params plus docstring — the whole discriminator at level 4.
      const line = compiled[t.name] ?? "";
      return line.slice(line.indexOf("(") + 1);
    }
    if (mapStyle === "signature") return signatureLine(t).slice(t.name.length);
    if (req.length) return req.join(",");
    return mapStyle === "explicit" ? "()" : "";
  };
  const bodyCounts = new Map<string, number>();
  for (const t of codeToTool.values()) {
    const b = lineBody(t);
    bodyCounts.set(b, (bodyCounts.get(b) ?? 0) + 1);
  }
  const lookalikeSizes = [...bodyCounts.values()].filter((n) => n > 1);
  const mapDiagnostics: Partial<CompressStats> = {
    ambiguousMapLines: lookalikeSizes.reduce((sum, n) => sum + n, 0),
    largestLookalikeGroup: lookalikeSizes.length ? Math.max(...lookalikeSizes) : 1,
    ...(isCompiled ? { uncompiledTools: uncompiled } : {}),
  };
  const wire = [
    {
      name: "t",
      description:
        isCompiled
          ? "Invoke a tool by its function name, exactly as declared in the Python block in the system prompt."
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
      description:
        isCompiled
          ? "Expand a function name to its full description and parameter signature (c), or search the declarations by keyword (s)."
          : "Expand a map code to its full name, description and parameter signature (c), or search the map by keyword (s).",
      input_schema: {
        type: "object",
        properties: { c: { type: "string" }, s: { type: "string" } },
      },
    },
  ];

  const mapLegend =
    mapStyle === "signature"
      ? "Each line is: code name(args), where ? marks optional. "
      : mapStyle === "explicit"
        ? "Each line is: code name required-args. A line ending in () takes no required arguments and can be called with none. "
        : "Each line is: code name required-args. ";
  const invokeHint =
    "Invoke with t(f=<code>, a={…}). Use q to expand a code before calling if you are unsure of its parameters.";
  const pyPreamble =
    "The tools available to you, as Python declarations. The docstring says what each one" +
    " is for and when to prefer it over a similar name:\n\n```python\n" +
    lines.join("\n") +
    '\n```\nInvoke with t(f="<function name>", a={…}). Use q to search by keyword.';

  const systemPreamble = isCompiled
    ? pyPreamble
    : `<toolmap>\n${lines.join("\n")}\n</toolmap>\n${mapLegend}${invokeHint}`;

  return finish(
    wire,
    systemPreamble,
    true,
    (rawName, rawArgs) => {
      let name = rawName;
      let args = asObject(rawArgs);

      // Observed on grok-4.5, on every level-3 map style: the model routes the
      // lookup tool through the dispatcher — t(f="q", a={s:"…"}) instead of
      // q(s="…"). The preamble invites it, saying "Invoke with t(f=<code>, a={…})"
      // and then "Use q to expand a code", which reads as everything going through
      // t. Tasks still completed, so this surfaced as wasted turns rather than as
      // failure. `t` and `q` are our own reserved names, so the intent is
      // unambiguous — nothing else could be meant.
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
          if (!t)
            return err(
              isCompiled
                ? `No function named "${args.c}". Search with q(s=…).`
                : `No map code "${args.c}". Search with q(s=…).`,
            );
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
        // A near miss is the common case, and a bare rejection costs another turn.
        const guess = nearest(String(args.f ?? ""), [...codeToTool.keys()]);
        return err(
          (isCompiled
            ? `No function named "${args.f}". Search with q(s=…).`
            : `No map code "${args.f}". Search with q(s=…).`) +
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
    mapDiagnostics,
  );
}

export { compileTools, verifyCompiledLine, describeForCompile, COMPILE_SYSTEM_PROMPT } from "./compile.js";
export type { Completion, CompileOptions, CompileResult } from "./compile.js";

export { recommendLevel } from "./recommend.js";
export type { Recommendation } from "./recommend.js";

export { forAnthropic, forOpenAI, forOpenAIResponses, forGemini } from "./providers/index.js";
export type { CacheTtl } from "./providers/index.js";
