/**
 * Every example must actually run.
 *
 * The README carried 27 code blocks, of which only 9 had imports — the rest were
 * fragments that could not be executed and so could not be verified. Six of the map
 * styles removed in 0.2.0 had appeared in examples, and hand-auditing caught three.
 *
 * These execute each file in examples/ and fail on a non-zero exit. An example that
 * stops working is a failing test, not a bug report from a user.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const files = readdirSync("examples").filter((f) => f.endsWith(".ts")).sort();

describe("examples", () => {
  it("there are examples to run", () => {
    expect(files.length).toBeGreaterThan(4);
  });

  for (const f of files) {
    it(`examples/${f} runs clean`, () => {
      // Offline by design: no example may require an API key.
      const out = execFileSync("npx", ["tsx", `examples/${f}`], {
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "", XAI_API_KEY: "" },
      });
      expect(out.length, `${f} produced no output`).toBeGreaterThan(0);
      expect(out).not.toMatch(/undefined|NaN|\[object Object\]/);
    });
  }
});

describe("the demo CLI runs, and does not truncate what matters", () => {
  /**
   * Added after a real UX bug: the demo capped every block at 6-14 lines, which cut the
   * model's final answer off mid-markdown-table — exactly at the header separator, so no
   * rows ever appeared and it read as "the table is broken". Truncating the answer in a
   * tool whose whole purpose is showing what happened is self-defeating.
   */
  const runDemo = (args: string[]) =>
    execFileSync("npx", ["tsx", "demo/cli.ts", "--offline", "--no-color", ...args], {
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "", XAI_API_KEY: "" },
    });

  for (const level of ["0", "1", "3"]) {
    it(`--level=${level} runs clean and dispatches the real tool`, () => {
      const out = runDemo([`--level=${level}`]);
      // Deliberately NOT /undefined/: the demo's Sentry fixture is the realistic
      // "TypeError: cannot read 'id' of undefined", so a bare word match flags correct
      // output. These are the shapes that actually indicate a bug — `undefined(...)` is
      // the exact artifact a malformed namespaceOf produced once.
      expect(out).not.toMatch(/\[object Object\]|\bNaN\b|:\s*undefined|undefined\(|=\s*undefined/);
      expect(out, "must show the real tool name coming back out of resolve()").toContain("github_create_issue");
      expect(out).toContain("RESULT");
    });
  }

  it("--compare prints the side-by-side table with a row per level", () => {
    const out = runDemo(["--compare"]);
    expect(out).toContain("SIDE BY SIDE");
    const body = out.slice(out.indexOf("SIDE BY SIDE"));
    for (const level of ["0", "1", "3"]) {
      expect(body, `no row for level ${level}`).toMatch(new RegExp(`^\\s*${level}\\s+6 → `, "m"));
    }
  });

  it("never truncates output with a '… N more lines' cap", () => {
    // The specific regression. Deliberate summarising says "(N more … not shown)"; a
    // silent line cap does not, and must not come back.
    const out = runDemo(["--level=3"]);
    expect(out).not.toMatch(/… \d+ more lines/);
  });

  it("keeps markdown table rows intact instead of re-wrapping them", async () => {
    // Guards the rule directly, since a live model does not emit a table on demand.
    const src = readFileSync("demo/cli.ts", "utf8");
    expect(src, "block() must special-case table rows").toMatch(/Never re-wrap a markdown table row/);
    expect(src).toMatch(/\/\^\\s\*\\\|\/\.test\(raw\)/);
  });

  it("level 3 demonstrates the error and meta outcomes, not just the happy path", () => {
    const out = runDemo(["--level=3"]);
    expect(out).toContain('kind: "error"');
    expect(out).toContain('kind: "meta"');
    expect(out).toContain("recoverable: true");
  });
});
