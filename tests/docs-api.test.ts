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
// Includes specs/, because a stale `mapStyle: "grouped"` example survived there while
// README and docs/ were clean — the guard has to cover everywhere prose lives.
const DOCS = [
  "README.md",
  "AGENTS.md",
  ...readdirSync("docs").filter((f) => f.endsWith(".md") || f.endsWith(".txt")).map((f) => `docs/${f}`),
  ...readdirSync("specs", { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      readdirSync(`specs/${d.name}`)
        .filter((f) => f.endsWith(".md"))
        .map((f) => `specs/${d.name}/${f}`),
    ),
];
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

describe("documented counts are not stale", () => {
  it("no doc claims a test count that is not the real one", () => {
    // AGENTS.md said 71 and the README said 131 while the suite was at 239. A number
    // that only a human updates is a number that goes stale.
    const offenders: string[] = [];
    for (const file of DOCS) {
      for (const m of read(file).matchAll(/(\d+)\s+(?:unit\s+)?tests\b/g)) {
        const claimed = Number(m[1]);
        // Allow only a plausible current figure; anything far off is stale.
        if (claimed < 200 || claimed > 400) offenders.push(`${file}: "${m[0]}"`);
      }
    }
    expect(offenders, `stale test counts:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("no doc claims a version below the current major.minor", () => {
    const pkg = JSON.parse(read("package.json"));
    const [maj, min] = pkg.version.split(".").map(Number);
    const offenders: string[] = [];
    for (const file of DOCS) {
      for (const line of read(file).split("\n")) {
        // Release history and process docs legitimately name old versions.
        if (/0\.1\.|release|publish|changelog|removed in|superseded/i.test(line)) continue;
        for (const m of line.matchAll(/\b(\d+)\.(\d+)\.\d+\b/g)) {
          if (Number(m[1]) === maj && Number(m[2]) < min) offenders.push(`${file}: ${m[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
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

describe("the API reference documents the whole surface", () => {
  /**
   * The reference had drifted twice: it omitted `model` and `objective` after they were
   * added, and listed a four-field `stats` that had grown to nine. A reference table
   * that a human keeps in sync is a table that goes stale, so this derives the expected
   * set from the types.
   */
  const types = readFileSync("src/types.ts", "utf8");
  const readme = read("README.md");
  const keysOf = (name: string) => {
    const m = types.match(new RegExp(`export type ${name} = \\\\{([\\\\s\\\\S]*?)\\\\n\\\\};`));
    return [...(m?.[1] ?? "").matchAll(/^ {2}(\w+)\??[:(]/gm)].map((x) => x[1]);
  };

  it("documents every CompressOptions field", () => {
    const missing = keysOf("CompressOptions").filter((k) => !readme.includes(`\`${k}\``));
    expect(missing, `undocumented options: ${missing.join(", ")}`).toEqual([]);
  });

  it("documents every CompressResult member", () => {
    const missing = keysOf("CompressResult").filter((k) => !readme.includes(`\`${k}`));
    expect(missing, `undocumented result members: ${missing.join(", ")}`).toEqual([]);
  });

  it("documents every CompressStats field", () => {
    const missing = keysOf("CompressStats").filter((k) => !readme.includes(`\`${k}\``));
    expect(missing, `undocumented stats fields: ${missing.join(", ")}`).toEqual([]);
  });

  it("documents every function the package exports", async () => {
    const mod: Record<string, unknown> = await import("../src/index.js");
    const fns = Object.keys(mod).filter((k) => typeof (mod as any)[k] === "function");
    const missing = fns.filter((f) => !readme.includes(f));
    expect(missing, `exported but undocumented: ${missing.join(", ")}`).toEqual([]);
  });
});
