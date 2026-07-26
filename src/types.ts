/** Public types. Everything a consumer touches is declared here. */

export type JsonSchema = {
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
  items?: any;
  enum?: any[];
  [k: string]: any;
};

/**
 * A tool as you already have it — the same shape MCP servers and every major
 * SDK produce. `inputSchema` and `input_schema` are both accepted.
 */
export type Tool = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  input_schema?: JsonSchema;
};

/** Normalized internal form. */
export type NormalizedTool = {
  name: string;
  description: string;
  schema: JsonSchema;
  ns: string;
  op: string;
};

/**
 * Compression levels. Each is a superset of the previous.
 *
 *  0  passthrough        — no change; useful as an A/B control in your own app
 *  1  signature          — flatten JSON Schema, keep native tools + real names
 *  2  namespace          — collapse related ops into one tool per namespace
 *  3  minified           — single dispatcher + opaque codes
 */
export type Level = 0 | 1 | 2 | 3;

// Type-only, so the cycle with policy.generated.ts (which imports MapStyle from
// here) is erased at compile time.
import type { Objective } from "./policy.generated.js";
export type { Objective };

/**
 * How each line of the level-3 `<toolmap>` is rendered.
 *
 *   name+required  `a0 github_create_issue owner,repo,title`   <- default
 *   explicit       `a0 github_create_issue owner,repo,title`
 *                  `a0 scorecard_lf_daily ()`  <- () = takes no required args
 *   signature      `a0 github_create_issue(owner,repo,title,body?,labels?)`
 *
 * Three styles, each with a measured reason to exist. Six others were tried and
 * removed in 0.2.0 because they made things worse — see docs/RESULTS.md Round 6.
 *
 * `name+required` is the default: the only style perfect on all four providers with
 * zero malformed arguments. It names required parameters because the dispatcher
 * levels give up provider-side constrained decoding, and a few tokens per tool buys
 * some of it back.
 *
 * `explicit` adds one thing: a `()` marker on tools that declare no required
 * parameters. On a real catalogue 44% of tools are like that, and their line would
 * otherwise be a bare name — indistinguishable from a tool whose parameters were
 * omitted, so the model spends a lookup finding out it could just call it. Measured
 * over 432 runs it cut lookups on all four providers and cost 9–21% less on three,
 * but **13% more on grok-4.5**. Reach for it via `objective: "cost"` rather than
 * setting it by hand.
 *
 * `signature` names optional parameters too, which removes most remaining lookups.
 * A bigger cached map traded for fewer turns — worth it where every turn pays for a
 * fresh round of reasoning, and measurably worse on xAI for reasons we cannot yet
 * explain.
 */
export type MapStyle = "name+required" | "explicit" | "signature";

export type CompressOptions = {
  level?: Level;
  /** Level 3 only. Ignored at levels 0–2, which emit no map. Default "name+required". */
  mapStyle?: MapStyle;
  /**
   * Group tools into namespaces. Default splits on the first `_` or `.`,
   * which matches MCP naming convention (`github_create_issue`).
   */
  namespaceOf?: (toolName: string) => { ns: string; op: string };
  /** Override the short alias used for a namespace at level 2. */
  aliasOf?: (ns: string) => string;
  /**
   * Level 1 only. Prepend `name(a,b?)` to each description. Default true, which is
   * the historical behaviour and what every published level-1 figure was measured with.
   *
   * **Experimental, and measured before it may become a default.** The prefix is fully
   * redundant with the `input_schema` level 1 retains — the model already has the tool
   * name, the property names, the required list, the enums and the item types — and it
   * costs 18.5% of the level-1 payload on the real 149-tool corpus. Setting this false
   * makes level 1 strictly smaller and removes the case where level 1 *inflates* a
   * terse catalogue.
   *
   * It is not the default because "smaller" is not the question. Every arm that
   * measured clean — zero malformed arguments, no extra turns — had the prefix, and a
   * one-line signature may be easier for a model to read than the equivalent JSON.
   * Whether that matters at level 1, where the schema is present anyway, is a
   * benchmark result and not yet in hand.
   */
  signaturePrefix?: boolean;
  /** Cap how many results a search/query meta-call returns. Default 8. */
  searchLimit?: number;
  /** Validate arguments against the original schema before dispatch. Default true. */
  validate?: boolean;
  /**
   * Exact model id, e.g. "gpt-5.6-sol". When given, level 3 selects the best
   * *measured* map style for that model from `src/policy.generated.ts`.
   *
   * Never a family: `gpt-5.6-sol` failing says nothing certain about `gpt-5.7`. An
   * unknown model gets the conservative default — an absence of evidence, not a
   * prediction. Behaviour is unchanged if you omit this.
   */
  model?: string;
  /**
   * What the selection optimises. Default "occupancy", because reclaiming context
   * window is the point — prompt caching already makes tool tokens cheap but does not
   * reclaim the room they take.
   *
   * As measured, "occupancy" currently selects the default on every known model: no
   * style beat it by more than 3.1% on that axis, under the 5% floor. The table has
   * real entries only for "cost".
   */
  objective?: Objective;
};

export type Resolution =
  | { kind: "call"; name: string; args: Record<string, any> }
  | { kind: "meta"; name: string; result: string }
  | { kind: "error"; message: string; recoverable: boolean };

export type CompressStats = {
  level: Level;
  /** The map style actually used. */
  mapStyle?: MapStyle;
  /** What the caller asked for, when it differed from what was used. */
  requestedMapStyle?: MapStyle;
  /** Why a requested style was not used. Absent when nothing was substituted. */
  fallbackReason?: string;
  toolCount: number;
  wireToolCount: number;
  originalChars: number;
  compressedChars: number;
  savedPct: number;
};

export type CompressResult = {
  /** Tool definitions to send on the wire, in Anthropic shape. */
  tools: unknown[];
  /** Text to append to your system prompt. Empty string at levels 0–1. */
  systemPreamble: string;
  /** Whether the preamble should sit behind a cache breakpoint. */
  cachePreamble: boolean;
  /** Translate a raw model tool call back to a real one. */
  resolve(rawName: string, rawArgs: Record<string, any>): Resolution;
  /** Map a real tool name to its level-3 code. Throws below level 3. */
  codeFor(toolName: string): string;
  /** Build the raw call a model would emit for a real tool. Test/debug aid. */
  encodeCallForTest(
    toolName: string,
    args: Record<string, any>,
  ): { name: string; args: Record<string, any> };
  stats: CompressStats;
};
