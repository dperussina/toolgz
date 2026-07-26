/**
 * Documentation must not reference an API that does not exist.
 *
 * 0.2.0 removed four map styles and one option after measuring them worse. Every one
 * of them appeared in a code example. Auditing that by hand caught three; this test
 * makes the next removal impossible to get wrong.
 *
 * Scope is deliberately narrow — it checks that identifiers named in docs are real,
 * not that prose is true. Prose accuracy is what docs/RESULTS.md and the drift guard
 * on the generated docs are for.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { compress } from "../src/index.js";
import type { Tool } from "../src/types.js";

const VALID_STYLES = ["name+required", "explicit", "signature"];
const DOCS = ["README.md", ...readdirSync("docs").filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
const read = (f: string) => readFileSync(f, "utf8");

/** A line is exempt if it is explicitly marked as historical. */
const isHistorical = (line: string) =>
  /removed in 0\.2\.0|before 0\.2\.0|were removed|no longer/i.test(line);

describe("documented map styles all exist", () => {
  for (const file of DOCS) {
    it(`${file} names only real styles`, () => {
      const offenders: string[] = [];
      for (const line of read(file).split("\n")) {
        if (isHistorical(line)) continue;
        for (const m of line.matchAll(/mapStyle:\s*"([^"]+)"/g)) {
          if (!VALID_STYLES.includes(m[1])) offenders.push(`${m[1]} — ${line.trim().slice(0, 80)}`);
        }
      }
      expect(offenders, `remove or mark historical:\n  ${offenders.join("\n  ")}`).toEqual([]);
    });
  }

  it("no doc mentions the cheatSheet option, which no longer exists", () => {
    for (const file of DOCS) {
      if (isHistorical(read(file))) continue;
      expect(read(file).includes("cheatSheet"), file).toBe(false);
    }
  });
});

describe("every documented style actually works when called", () => {
  const TOOLS: Tool[] = [
    { name: "svc_with_args", description: "d", inputSchema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } },
    { name: "svc_no_args", description: "d", inputSchema: { type: "object", properties: {} } },
  ];

  it("compresses and round-trips under each style named in the docs", () => {
    const named = new Set<string>();
    for (const file of DOCS) {
      for (const m of read(file).matchAll(/mapStyle:\s*"([^"]+)"/g)) {
        if (VALID_STYLES.includes(m[1])) named.add(m[1]);
      }
    }
    expect(named.size).toBeGreaterThan(0);
    for (const mapStyle of named) {
      const c = compress(TOOLS, { level: 3, mapStyle: mapStyle as any });
      const raw = c.encodeCallForTest("svc_with_args", { a: "x" });
      const r = c.resolve(raw.name, raw.args);
      expect(r.kind, mapStyle).toBe("call");
      if (r.kind === "call") expect(r.name).toBe("svc_with_args");
    }
  });

  it("the README's per-model example produces what the README claims", () => {
    // README shows: model gpt-5.6-sol + objective cost -> explicit, no fallback.
    const c = compress(TOOLS, { level: 3, model: "gpt-5.6-sol", objective: "cost" });
    expect(c.stats.mapStyle).toBe("explicit");
    expect(c.stats.requestedMapStyle).toBeUndefined();
    expect(c.stats.fallbackReason).toBeUndefined();
  });

  it("the README's claim that the broken-pair table is empty is true", () => {
    expect(read("README.md")).toMatch(/table is currently\s*\n?\s*empty|currently\s+\*\*empty\*\*/i);
  });
});
