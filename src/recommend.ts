import type { Level, Tool } from "./types.js";
import { defaultNamespaceOf, countSchemaTokensApprox } from "./render/index.js";
import { compress } from "./index.js";

export type Recommendation = {
  level: Level;
  reason: string;
  toolCount: number;
  namespaceCount: number;
  opsPerNamespace: number;
};

/**
 * Pick a level for a given tool set.
 *
 * Thresholds here are measured, not assumed — see docs/RESULTS.md.
 *
 * Two findings shape this function, and both contradicted the design's
 * starting assumptions:
 *
 *  - **Level 3 does not cost accuracy.** 150 runs over 10 scenarios, including
 *    clusters built specifically to confuse a minified name map: 48/48 correct
 *    calls, zero hallucinated names. It was also the fastest and cheapest arm.
 *    The real cost is turns (+0.6) and lookup round-trips (~1.7/run), so it is
 *    recommended by size, not withheld by superstition.
 *
 *    Re-tested on Sonnet 5 and Haiku 4.5: 60/60 correct, still zero
 *    hallucinated codes. What degrades on weaker models is argument
 *    *formatting*, not tool *choice*: malformed arguments went 0-in-20 on
 *    Opus, 3-in-10 on Sonnet, 17-in-30 on Haiku, and every one was caught by
 *    `validate` and recovered — all tasks still completed. That is precisely
 *    why validation defaults to on. On a weak model, disabling it converts
 *    roughly half of all runs from a recovered retry into a bad dispatch.
 *  - **Level 2 is dominated.** More tokens, six times the malformed arguments,
 *    slower and dearer than level 3. It is never recommended. It stays in the
 *    API for callers who need real operation names on the wire.
 *
 * The level 1 → 3 threshold is driven by tools-per-namespace, not tool count:
 * the compound-dispatcher overhead is paid per namespace, so a wide, sparse
 * tool set stays cheaper at level 1 even when the total count is large.
 */
export function recommendLevel(
  tools: Tool[],
  namespaceOf: (n: string) => { ns: string; op: string } = defaultNamespaceOf,
): Recommendation {
  const namespaces = new Set(tools.map((t) => namespaceOf(t.name).ns));
  const toolCount = tools.length;
  const namespaceCount = namespaces.size;
  const opsPerNamespace = namespaceCount ? toolCount / namespaceCount : 0;

  const base = { toolCount, namespaceCount, opsPerNamespace };

  // Size the level-1 block by asking the library what it would actually emit, rather
  // than reconstructing it — an earlier version rebuilt the schema by hand, kept the
  // full descriptions where level 1 emits a signature line, and overestimated by ~34%.
  //
  // `countSchemaTokensApprox` counts characters. Measured against `count_tokens` on
  // real MCP tools the ratio is a stable ~2.1 chars/token (1.98 at 10 tools, 2.15 at
  // 149), so dividing gives a fair local estimate with no API call.
  const CHARS_PER_TOKEN = 2.1;
  const l1Tokens = Math.round(
    compress(tools, { level: 1 }).stats.compressedChars / CHARS_PER_TOKEN,
  );

  // The old heuristic gated level 3 on `opsPerNamespace >= 4`. That is a LEVEL-2
  // question: level 2 pays dispatcher overhead per namespace, so its shape matters
  // there. Level 3 uses one flat dispatcher and does not care about namespaces at all.
  //
  // The consequence was concrete: on the 149-tool real corpus (63 namespaces, 2.4 ops
  // each) it recommended level 1 at 41,648 tokens when level 3 measures 2,980 — leaving
  // ~38,700 tokens on the table. Measured on real tools, level 3 is smaller at EVERY
  // count tested, down to 5 tools (635 vs 1,178).
  //
  // So size never argues for level 1. What argues for level 1 is that it keeps the
  // provider's own schema enforcement, which levels 2-3 give up. That is worth more
  // than a saving you would not notice — hence an absolute threshold on the block,
  // not a shape test.
  const THRESHOLD_TOKENS = 4000;

  if (l1Tokens < THRESHOLD_TOKENS) {
    return {
      ...base,
      level: 1,
      reason: `The tool block is only ~${l1Tokens.toLocaleString()} tokens at level 1. Level 3 would be smaller, but not by enough to be worth giving up the provider's own argument validation, which level 1 keeps. Reach for level 3 when the block is large enough that reclaiming it changes what fits in your context.`,
    };
  }

  return {
    ...base,
    level: 3,
    reason: `${toolCount} tools take ~${l1Tokens.toLocaleString()} tokens at level 1; level 3 replaces them with two dispatcher tools plus a cached map. Measured on 149 real MCP tools: 41,648 tokens at level 1 against 2,980 at level 3, and 60/60 tasks completed across four frontier providers with zero hallucinated names. The cost is roughly 0.3-1.7 lookup calls per task — so about half an extra turn — plus the loss of provider-side argument checking — keep \`validate\` on, which is what catches malformed arguments instead. If latency matters more than context, stay at level 1.`,
  };
}
