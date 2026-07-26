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
import { readdirSync } from "node:fs";
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
