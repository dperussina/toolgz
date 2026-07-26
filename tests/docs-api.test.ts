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
  // Shipped in the npm tarball and written for a consumer's coding agent, so a stale
  // identifier here gets acted on rather than merely read.
  "llms.txt",
  ...readdirSync("docs").filter((f) => f.endsWith(".md") || f.endsWith(".txt")).map((f) => `docs/${f}`),
  ...readdirSync("examples").filter((f) => f.endsWith(".md")).map((f) => `examples/${f}`),
  ...readdirSync("specs", { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      readdirSync(`specs/${d.name}`)
        .filter((f) => f.endsWith(".md"))
        .map((f) => `specs/${d.name}/${f}`),
    ),
];
const read = (f: string) => readFileSync(f, "utf8");

/**
 * A mention is exempt if it or its immediate context is marked historical.
 *
 * Line-scoped matching was not enough: RESULTS.md explains the removals across two
 * lines, with "removed in 0.2.0" on the first and the style name on the second, and the
 * guard flagged the explanation of the very thing it checks for.
 */
const isHistorical = (lines: string[], i: number) =>
  lines
    .slice(Math.max(0, i - 2), i + 2)
    .some((l) => /removed in 0\.2\.0|before 0\.2\.0|were removed|no longer|superseded|historical record|disqualif/i.test(l));

describe("documented map styles all exist", () => {
  for (const file of DOCS) {
    it(`${file} names only real styles`, () => {
      const offenders: string[] = [];
      const lines = read(file).split("\n");
      lines.forEach((line, i) => {
        if (isHistorical(lines, i)) return;
        for (const m of line.matchAll(/mapStyle:\s*"([^"]+)"/g)) {
          if (!VALID_STYLES.includes(m[1])) offenders.push(`${m[1]} — ${line.trim().slice(0, 80)}`);
        }
      });
      expect(offenders, `remove or mark historical:\n  ${offenders.join("\n  ")}`).toEqual([]);
    });
  }

  it("no doc mentions the cheatSheet option, which no longer exists", () => {
    for (const file of DOCS) {
      const lines = read(file).split("\n");
      const live = lines.filter((l, i) => l.includes("cheatSheet") && !isHistorical(lines, i));
      expect(live, `${file} still documents cheatSheet: ${live.join(" | ")}`).toEqual([]);
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

describe("documented imports name real exports", () => {
  /**
   * Doc code blocks cannot be typechecked standalone — they reference `myTools`, `block`
   * and other caller-side variables by design. But their imports are checkable, and a
   * rename or removal shows up there first.
   */
  it("every `from \"toolgz\"` import in the docs resolves", async () => {
    const mod: Record<string, unknown> = await import("../src/index.js");
    const providers: Record<string, unknown> = await import("../src/providers/index.js");
    const known = new Set([...Object.keys(mod), ...Object.keys(providers)]);
    const offenders: string[] = [];
    for (const file of DOCS) {
      for (const m of read(file).matchAll(/import\s*\{([^}]+)\}\s*from\s*"toolgz(?:\/providers)?"/g)) {
        for (const raw of m[1].split(",")) {
          const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
          if (name && !known.has(name)) offenders.push(`${file}: ${name}`);
        }
      }
    }
    expect(offenders, `docs import names that do not exist:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("no doc calls a method that CompressResult does not have", () => {
    const types = readFileSync("src/types.ts", "utf8");
    const m = types.match(/export type CompressResult = \{([\s\S]*?)\n\};/);
    const members = new Set([...(m?.[1] ?? "").matchAll(/^ {2}(\w+)/gm)].map((x) => x[1]));
    const offenders: string[] = [];
    for (const file of DOCS) {
      // `c.` is the conventional handle for a CompressResult throughout the docs.
      for (const call of read(file).matchAll(/\bc\.(\w+)/g)) {
        if (!members.has(call[1])) offenders.push(`${file}: c.${call[1]}`);
      }
    }
    expect(offenders, `docs call missing members:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});

describe("RESULTS.md run total matches the committed data", () => {
  /**
   * The header claimed "~2,900 runs" because I estimated it. The real figure is 3,203.
   * A total nobody recomputes is a total that drifts, and this one is the headline
   * credibility claim of the whole document.
   */
  it("states the real number of committed runs", () => {
    let actual = 0;
    for (const f of readdirSync("bench/results").filter((f) => f.endsWith(".jsonl"))) {
      actual += readFileSync(`bench/results/${f}`, "utf8").split("\n").filter((l) => l.trim()).length;
    }
    const claimed = read("docs/RESULTS.md").match(/\*\*Total\*\*:\s*([\d,]+)\s*runs/);
    expect(claimed, "RESULTS.md must state a run total").toBeTruthy();
    expect(Number(claimed![1].replace(/,/g, ""))).toBe(actual);
  });
});
