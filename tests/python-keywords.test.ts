/**
 * Level 4 promises valid Python. A parameter named `from` breaks that promise, and the
 * corpus has three of them.
 *
 * Found by inspecting a map this project had already published. `send_email_with_attachments`
 * was missing from the shipped artifact — 148 of 149 tools — and the reason was not a model
 * failure:
 *
 *   0.5.1's compile wrote  def send_email_with_attachments(...,from=None,...)   <- SyntaxError
 *                                                                                  and ACCEPTED
 *   0.6.0's compile wrote  def send_email_with_attachments(...,**{"from":None})  <- valid Python
 *                                                                                  and REJECTED
 *
 * Accepting invalid syntax while rejecting the only valid spelling is the worst of both
 * outcomes, so both halves are pinned here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compress } from "../src/index.js";
import { verifyCompiledLine } from "../src/compile.js";
import { signatureLine, isPythonIdentifier } from "../src/render/index.js";
import type { Tool } from "../src/types.js";

const emailTool: Tool = {
  name: "send_email",
  description: "Send an email.",
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string" },
      from: { type: "string" },
      subject: { type: "string" },
      attachments: { type: "array", items: { type: "object", properties: {} } },
    },
    required: ["to", "subject"],
  },
} as Tool;

describe("Python reserved words cannot be parameter names", () => {
  it("knows which names are legal", () => {
    expect(isPythonIdentifier("subject")).toBe(true);
    expect(isPythonIdentifier("_private")).toBe(true);
    expect(isPythonIdentifier("from")).toBe(false);
    expect(isPythonIdentifier("class")).toBe(false);
    expect(isPythonIdentifier("lambda")).toBe(false);
    expect(isPythonIdentifier("None")).toBe(false);
    expect(isPythonIdentifier("user-id")).toBe(false); // not an identifier at all
  });

  it("moves them into a trailing **{} when rendering Python", () => {
    const sig = signatureLine(emailTool, undefined, { python: true });
    expect(sig).toBe('send_email(to,subject,attachments?:object[],**{"from":None})');
    // The wire name survives verbatim. `from_` would compile and send the wrong key.
    expect(sig).toContain('"from"');
    expect(sig).not.toContain("from_");
    expect(sig).not.toMatch(/\bfrom[,)?=]/);
  });

  it("marks a required keyword parameter as required, not defaulted", () => {
    const required = {
      ...emailTool,
      input_schema: { ...(emailTool as any).input_schema, required: ["to", "from"] },
    } as Tool;
    expect(signatureLine(required, undefined, { python: true })).toContain('**{"from":...}');
  });

  it("leaves levels 1 and 3 alone — those lines are not Python", () => {
    // `from?` is clearer than `**{"from":None}` where nothing claims to be executable,
    // and changing it would cost bytes on every catalogue to fix a Python-only problem.
    // Parameters keep schema order; only the Python rendering has to move one.
    expect(signatureLine(emailTool)).toBe("send_email(to,from?,subject,attachments?:object[])");
  });
});

describe("the verifier reads both spellings", () => {
  it("accepts the valid one", () => {
    expect(
      verifyCompiledLine(
        'def send_email(to,subject,attachments=None,**{"from":None}):"send mail"',
        emailTool,
      ),
    ).toBeNull();
  });

  it("rejects the SyntaxError it used to ship", () => {
    const reason = verifyCompiledLine(
      'def send_email(to,subject,from=None):"send mail"',
      emailTool,
    );
    expect(reason).toMatch(/not valid Python/);
    expect(reason).toMatch(/reserved word/);
    // and it says what to do instead
    expect(reason).toMatch(/\*\*\{"from":None\}/);
  });

  it("still catches an invented parameter hidden inside **{}", () => {
    expect(
      verifyCompiledLine('def send_email(to,subject,**{"sender":None}):"send mail"', emailTool),
    ).toMatch(/invented parameter\(s\): sender/);
  });

  it("counts a kwarg towards required coverage rather than reporting it dropped", () => {
    const required = {
      ...emailTool,
      input_schema: { ...(emailTool as any).input_schema, required: ["from"] },
    } as Tool;
    expect(verifyCompiledLine('def send_email(**{"from":...}):"send mail"', required)).toBeNull();
  });
});

describe("the real corpus", () => {
  const raw = JSON.parse(readFileSync("bench/fixtures/real-mcp-tools.json", "utf8"));
  const tools: Tool[] = Array.isArray(raw) ? raw : raw.tools;

  it("has keyword-named parameters, so this is not a hypothetical", () => {
    const offenders = tools.filter((t) =>
      Object.keys((t as any).input_schema?.properties ?? {}).some((k) => !isPythonIdentifier(k)),
    );
    expect(offenders.length).toBeGreaterThan(0);
  });

  it("emits no reserved word as a parameter anywhere in a level-4 map", () => {
    const compiled = JSON.parse(readFileSync("bench/fixtures/python-map.json", "utf8"));
    const map = (compress(tools, { level: 4, compiled: compiled.compiled ?? compiled }) as any)
      .systemPreamble as string;
    const bad: string[] = [];
    for (const line of map.split("\n")) {
      const m = line.match(/^def\s+[\w]+\s*\(([^)]*)\)/);
      if (!m) continue;
      for (const p of m[1]
        .replace(/\*\*\{[^}]*\}/g, "")
        .split(",")
        .map((x) => x.trim().split(/[=:?]/)[0].trim())
        .filter(Boolean)) {
        if (!isPythonIdentifier(p)) bad.push(`${line.slice(0, 60)} → ${p}`);
      }
    }
    expect(bad, `level-4 map contains invalid Python:\n  ${bad.join("\n  ")}`).toEqual([]);
  });
});
