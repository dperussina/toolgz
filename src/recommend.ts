import type { Level, Tool } from "./types.js";
import { defaultNamespaceOf } from "./render/index.js";

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
 *    Re-tested on Sonnet 5 and Haiku 4.5: 40/40 correct, still zero
 *    hallucinated codes. What degrades on weaker models is argument
 *    *formatting* (malformed args 0 → 3 → 6), not tool *choice* — and every
 *    one was caught by `validate` and recovered. That is precisely why
 *    validation defaults to on; disabling it converts a recovered retry into a
 *    bad dispatch.
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

  if (toolCount < 15) {
    return {
      ...base,
      level: 1,
      reason: `Only ${toolCount} tools — flattening schemas captures nearly all the available saving, and namespace collapse would add dispatcher overhead for little return.`,
    };
  }

  if (opsPerNamespace < 4) {
    return {
      ...base,
      level: 1,
      reason: `${toolCount} tools spread across ${namespaceCount} namespaces (${opsPerNamespace.toFixed(1)} ops each). The compound-dispatcher overhead is paid per namespace, so a set this sparse stays smaller at level 1.`,
    };
  }

  return {
    ...base,
    level: 3,
    reason: `${toolCount} tools across ${namespaceCount} namespaces (${opsPerNamespace.toFixed(1)} ops each) — deep enough that a single dispatcher plus a cached code map beats per-tool definitions. Measured at ~82% fewer prompt tokens with no accuracy penalty across Opus 5, Sonnet 5 and Haiku 4.5, at the cost of roughly 0.6 extra turns and 1.7 lookup calls per task. Keep argument validation on — on weaker models malformed arguments rise and validation is what catches them. If your workload is latency-critical rather than context-critical, drop to level 1.`,
  };
}
