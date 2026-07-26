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

/**
 * How each line of the level-3 `<toolmap>` is rendered.
 *
 *   name           `a0 github_create_issue`
 *   name+required  `a0 github_create_issue owner,repo,title`   <- default
 *   compact        `aa github_create_issue owner repo title`
 *   signature      `a0 github_create_issue(owner,repo,title,body?,labels?)`
 *   terse          `a0 create new issue in repository`
 *   nocode         `github_create_issue owner,repo,title`
 *   grouped        `github: create_issue(owner,repo,title) search_issues(q)`
 *
 * `name+required` is the default, chosen on measurement: it costs a few tokens per
 * tool and cuts malformed arguments on models that fill the generic argument bag
 * badly, because the dispatcher levels give up provider-side constrained decoding
 * and this buys some of it back cheaply. `name` is smaller and failed
 * deterministically on grok-4.5. `signature` also names optional parameters, which
 * removes most remaining `q()` lookups — a bigger cached map traded for fewer
 * turns, which matters where every turn pays for a fresh round of reasoning.
 * `terse` drops the real name entirely; most aggressive, least legible.
 *
 * The rest are experimental and NOT recommended until the cross-provider accuracy
 * sweep clears them.
 *
 * `nocode` and `grouped` drop the code column, since the map already carries the
 * real name and so pays for identity twice. With no code the tool's own name is its
 * map key, which also removes a failure mode seen in the wild (a model calling the
 * code as the tool name — see tests/robustness.test.ts).
 *
 * `explicit` is the cheap answer to the same problem `optional` attacks. On a real
 * catalogue 44% of tools declare no required parameters, so their map line is a bare
 * name — indistinguishable from a tool whose parameters were simply omitted. Those
 * tools are callable with NO arguments at all, and the map never says so, which is
 * why models spend a q() lookup confirming. `explicit` marks them `name ()`.
 * Measured: naming four optional parameters each costs ~2,640 characters; the marker
 * costs ~198, thirteen times less, and states the fact the model actually lacks.
 *
 * `compact` carries exactly the same information as `name+required` and the same map
 * contract, but serialises it more cheaply: a space rather than a comma between
 * required arguments (identical character count, ~3% fewer tokens on every tokenizer
 * measured) and a flat two-letter code rather than the namespace-prefixed `a0` form.
 * Measured on 149 real MCP tools: −14.4% map tokens on claude-opus-5, −16.6% on
 * gpt-5.6-sol, −16.2% on gemini-3.1-pro, −14.4% on grok-4.5, against a character
 * reduction of only 3.5% — which is why this was measured in tokens, not characters.
 */
// Type-only, so the cycle with policy.generated.ts (which imports MapStyle from
// here) is erased at compile time.
import type { Objective } from "./policy.generated.js";
export type { Objective };

export type MapStyle =
  | "name"
  | "name+required"
  | "signature"
  | "terse"
  | "nocode"
  | "grouped"
  | "compact"
  | "optional"
  | "explicit";

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
  /**
   * Level 3 only. Prepend a generated `<toolgz>` cheat sheet to the preamble.
   *
   * Motivated by measurement on a real 149-tool catalogue: 66 tools (44%) declare
   * no required parameters, so a `name+required` map line degenerates to a bare
   * name and hides 451 optional parameters behind a `q()` lookup. Lookups are the
   * dominant cost — going from 0 to 2 of them was a 6x cost increase.
   *
   * Listing those parameters per tool would cost ~800 tokens. But 21 distinct
   * names cover 402 of the 451 slots, and 46 of the 66 tools are fully described
   * by that shared set, so stating them ONCE costs ~40. The sheet is generated
   * from the tool set, never hand-written, and is fully deterministic so the
   * cached prefix stays byte-stable.
   */
  cheatSheet?: boolean;
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
