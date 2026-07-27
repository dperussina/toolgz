/**
 * Guards on what actually reaches a consumer.
 *
 * These exist because 0.1.0 shipped with `@anthropic-ai/sdk`, `@google/genai`,
 * `openai` and `dotenv` declared as runtime `dependencies` — about 45MB — while
 * `src/` imports none of them. They are used only by `bench/`, `docs/` and the
 * live-integration tests, none of which are published. Every `npm install toolgz`
 * paid for four SDKs it never loaded, which is a poor trade in any library and an
 * embarrassing one in a library about reclaiming space.
 *
 * The rule enforced here is stronger than "don't repeat that mistake": a declared
 * runtime dependency must be one `src/` actually imports.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** Every .ts file under src/, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Bare module specifiers imported by src/ — i.e. not relative and not a
 * `node:`-prefixed builtin. Import statements only: a specifier appearing inside
 * a doc comment (src/index.ts shows `import { compress } from "toolgz"` as usage
 * documentation) is not a real dependency.
 */
function bareImports(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(join(ROOT, "src"))) {
    const src = readFileSync(file, "utf8");
    // Strip block and line comments so documented examples do not count.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const m of code.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      // "@scope/pkg/sub" and "pkg/sub" both resolve to their package root.
      found.add(
        spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0],
      );
    }
  }
  return found;
}

describe("published package weight", () => {
  it("declares no runtime dependency that src/ does not import", () => {
    const declared = Object.keys(pkg.dependencies ?? {});
    const imported = bareImports();
    const unused = declared.filter((d) => !imported.has(d));
    expect(
      unused,
      `Declared as runtime deps but never imported by src/: ${unused.join(", ")}. ` +
        `Move them to devDependencies — consumers install dependencies, and ` +
        `bench/, docs/ and integration tests are not published.`,
    ).toEqual([]);
  });

  it("imports nothing bare that is not declared", () => {
    // The other direction: an undeclared runtime import is a broken install.
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const missing = [...bareImports()].filter((i) => !declared.has(i) && i !== pkg.name);
    expect(
      missing,
      `src/ imports these but package.json does not declare them: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("currently has zero runtime dependencies", () => {
    // Not a law of nature — but adding the first one should be a deliberate act
    // that trips this test, not something noticed after publishing.
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});

describe("the library core stays runtime-agnostic", () => {
  /**
   * `types: ["node"]` was added to tsconfig so src/cli could be written at all. That also
   * makes Node globals visible to every other file, so the boundary the compiler used to
   * enforce is now enforced here: only the CLI may touch Node.
   *
   * It matters because the library is meant to run in a worker, an edge function or a
   * browser, and a stray `process.env` or `node:fs` import would break that silently —
   * the package would still build, still test, and fail only in someone's deploy.
   */
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : join(dir, e.name).endsWith(".ts") ? [join(dir, e.name)] : [],
    );

  it("no file outside src/cli imports a node: builtin or uses a Node global", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      if (file.includes("/cli/")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/from\s+["'](node:[^"']+)["']/g)) offenders.push(`${file}: imports ${m[1]}`);
      for (const g of ["process.", "__dirname", "Buffer."]) {
        // Ignore mentions inside comments; only flag real references.
        const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        if (stripped.includes(g)) offenders.push(`${file}: uses ${g}`);
      }
    }
    expect(offenders, `library core must not depend on Node:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("the CLI is the only thing allowed to, and it does", () => {
    // Asserted so the rule above cannot pass by the CLI quietly disappearing.
    expect(existsSync("src/cli/compile.ts")).toBe(true);
    expect(readFileSync("src/cli/compile.ts", "utf8")).toMatch(/from "node:fs"/);
  });

  it("compileTools reaches a model only through the caller's function", () => {
    // The zero-dependency guarantee for the compile feature, stated as a test.
    const src = readFileSync("src/compile.ts", "utf8");
    expect(src).not.toMatch(/from\s+["']node:/);
    expect(src).not.toMatch(/fetch\(/);
    expect(src).toMatch(/complete/);
  });
});

describe("published file list", () => {
  it("ships only build output, docs for humans and agents, and legal files", () => {
    expect(pkg.files).toEqual(["dist", "README.md", "llms.txt", "LICENSE", "NOTICE"]);
  });

  it("ships llms.txt, because an agent cannot read a file that was not published", () => {
    // The integration instructions for a consumer's coding agent are only useful if
    // they land in node_modules. This is the whole point of the file, so it is asserted
    // rather than trusted to the `files` array staying correct.
    expect(pkg.files).toContain("llms.txt");
    expect(existsSync("llms.txt"), "llms.txt is listed in files but does not exist").toBe(true);
  });

  it("llms.txt states the rules an agent most often gets wrong", () => {
    // Not a style check: each of these is a defect we have actually seen or fielded.
    // If the file is rewritten, these must survive the rewrite.
    const llms = readFileSync("llms.txt", "utf8");
    for (const rule of [
      "resolve",             // dispatching block.name directly breaks at level 3
      "systemPreamble",      // level 3 without the map is unusable
      "never changes level",  // compress() does not self-upgrade
      "validate",            // turning it off converts retries into bad dispatches
      "forOpenAIResponses",  // wrong adapter + reasoning is rejected at the API
      "functionDeclarations", // Gemini returns one wrapper, not one tool per tool
      "tiktoken",            // wrong for Claude by 15-20%
      "CHARACTER saving",    // savedPct is not a token or cost saving
    ]) {
      expect(llms, `llms.txt no longer mentions ${rule}`).toContain(rule);
    }
  });

  it("does not ship source, tests, benchmarks or env samples", () => {
    for (const leaked of ["src", "bench", "tests", "docs", ".env", ".env.example", "brain"]) {
      expect(pkg.files).not.toContain(leaked);
    }
  });

  it("points its entry points at dist/", () => {
    expect(pkg.main).toMatch(/^dist\//);
    expect(pkg.types).toMatch(/^dist\//);
    for (const entry of Object.values<any>(pkg.exports)) {
      expect(entry.import).toMatch(/^\.\/dist\//);
      expect(entry.types).toMatch(/^\.\/dist\//);
    }
  });
});
