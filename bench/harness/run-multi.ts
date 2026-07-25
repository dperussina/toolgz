/**
 * Cross-provider benchmark runner.
 *
 *   npx tsx bench/harness/run-multi.ts --provider=openai --reps=3
 *   npx tsx bench/harness/run-multi.ts --provider=all --suite=both --reps=3
 *
 * Differences from the Anthropic-only runner (bench/harness/run.ts):
 *  - Arms are the four portable ones. `native` is dropped: Anthropic
 *    server-side tool search has no cross-provider equivalent, so including it
 *    would compare a feature against its own absence.
 *  - Prompt caching is left to whatever each provider does automatically. No
 *    cache breakpoints are placed, because only Anthropic has an explicit one
 *    and using it on Anthropic alone would bias the comparison.
 *  - Token and dollar figures are NOT comparable across providers (different
 *    tokenizers, different prices). Compare arms *within* a provider; the
 *    cross-provider claim is about the ranking, not the magnitudes.
 */
import "dotenv/config";
import { mkdirSync, appendFileSync } from "node:fs";
import { ARMS, A_VARIANTS } from "../strategies/index.js";
import { SCENARIOS, type Scenario } from "../scenarios.js";
import { ACCURACY_SCENARIOS } from "../scenarios-accuracy.js";
import type { CompressionStrategy } from "../core/types.js";
import type {
  ChatMessage,
  Provider,
  ToolResult,
  WireTool,
} from "../providers/types.js";
import { anthropicProvider } from "../providers/anthropic.js";

const OUT_DIR = new URL("../results/", import.meta.url).pathname;
mkdirSync(OUT_DIR, { recursive: true });

const SYSTEM_BASE =
  "You are an operations agent with access to tools. Use the tools to complete the user's request. Do not ask clarifying questions — make reasonable assumptions and act. When the task is complete, reply with a one-line summary.";

/** `native` is Anthropic-only and is excluded from cross-provider runs. */
const PORTABLE_ARMS: CompressionStrategy[] = ARMS.filter(
  (a) => a.id !== "native",
);

/** --variants adds the arm-A hardening candidates. */
const withVariants = process.argv.includes("--variants");
const ACTIVE_ARMS: CompressionStrategy[] = withVariants
  ? [...PORTABLE_ARMS, ...A_VARIANTS]
  : PORTABLE_ARMS;

async function loadProviders(which: string): Promise<Provider[]> {
  const out: Provider[] = [];
  const want = (id: string) => which === "all" || which === id;

  if (want("anthropic")) out.push(anthropicProvider);

  // Adapters are loaded lazily so a missing/broken one does not block the rest.
  for (const [id, path] of [
    ["openai", "../providers/openai.js"],
    ["gemini", "../providers/gemini.js"],
    ["xai", "../providers/xai.js"],
  ] as const) {
    if (!want(id)) continue;
    try {
      const mod: any = await import(path);
      const p = mod[`${id}Provider`] ?? mod.default;
      if (p) out.push(p);
      else console.error(`! ${id}: module has no ${id}Provider export`);
    } catch (e: any) {
      console.error(`! ${id}: not loaded — ${e.message?.split("\n")[0]}`);
    }
  }
  return out;
}

function argsMatch(expected: Record<string, any> | undefined, actual: any) {
  if (!expected) return true;
  for (const [k, v] of Object.entries(expected)) {
    const a = actual?.[k];
    if (typeof v === "string" && typeof a === "string") {
      if (a.trim().toLowerCase() !== v.trim().toLowerCase()) return false;
    } else if (a !== v) return false;
  }
  return true;
}

async function runOne(
  provider: Provider,
  strat: CompressionStrategy,
  sc: Scenario,
  rep: number,
) {
  const compiled = strat.compile(sc.tools);
  const started = Date.now();

  const messages: ChatMessage[] = [{ role: "user", content: sc.prompt }];
  const observed: { name: string; args: any }[] = [];
  let metaCalls = 0;
  let hallucinated = 0;
  let malformed = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let occupancy = 0;
  let usd = 0;
  let turn = 0;
  let error: string | undefined;
  /** Diagnostics: what the model actually emitted when resolve() rejected it. */
  const rejects: { raw: string; args: string; why: string }[] = [];

  try {
    while (turn < sc.maxTurns) {
      turn++;
      const res = await provider.chat({
        system: SYSTEM_BASE,
        systemPreamble: compiled.systemPreamble,
        tools: compiled.tools as WireTool[],
        messages,
        // Matches bench/harness/run.ts. Opus 5 runs adaptive thinking by
        // default and max_tokens caps thinking + response together; starving it
        // produced extra turns in testing.
        maxTokens: 8000,
      });

      promptTokens += res.usage.promptTokens;
      outputTokens += res.usage.outputTokens;
      occupancy = res.usage.promptTokens;
      // Cached input bills at a discount where the provider offers one; without
      // that, heavy-caching providers look artificially expensive.
      const cached = Math.min(res.usage.cachedTokens ?? 0, res.usage.promptTokens);
      const uncached = res.usage.promptTokens - cached;
      usd +=
        uncached * provider.priceIn +
        cached * (provider.priceCachedIn ?? provider.priceIn) +
        res.usage.outputTokens * provider.priceOut;

      if (res.stopReason === "refusal") {
        error = "refusal";
        break;
      }
      if (!res.toolCalls.length) break;

      messages.push({
        role: "assistant",
        toolCalls: res.toolCalls,
        text: res.text,
        raw: res.raw,
      });

      const results: ToolResult[] = [];
      for (const call of res.toolCalls) {
        const r = strat.resolve(sc.tools, call.name, call.args ?? {});
        if (r.kind === "meta") {
          metaCalls++;
          results.push({ id: call.id, name: call.name, content: r.result });
        } else if (r.kind === "error") {
          if (/no such tool|no code|unknown op/i.test(r.message)) hallucinated++;
          else malformed++;
          rejects.push({
            raw: call.name,
            args: JSON.stringify(call.args ?? {}).slice(0, 300),
            why: r.message.slice(0, 200),
          });
          results.push({
            id: call.id,
            name: call.name,
            content: `Error: ${r.message}`,
            isError: true,
          });
        } else {
          observed.push({ name: r.name, args: r.args });
          results.push({
            id: call.id,
            name: call.name,
            content: sc.results[r.name] ?? '{"ok":true}',
          });
        }
      }
      messages.push({ role: "tool_results", results });
    }
  } catch (e: any) {
    error = (e?.message ?? String(e)).split("\n")[0].slice(0, 200);
  }

  // Expected calls must appear in order (subsequence match).
  let correct = 0;
  let cursor = 0;
  for (const exp of sc.expected) {
    for (let i = cursor; i < observed.length; i++) {
      if (observed[i].name === exp.name && argsMatch(exp.args, observed[i].args)) {
        correct++;
        cursor = i + 1;
        break;
      }
    }
  }

  return {
    provider: provider.id,
    model: provider.model,
    scenario: sc.id,
    arm: strat.id,
    rep,
    toolBlockTokens: 0,
    turns: turn,
    totalPromptTokens: promptTokens,
    totalOutputTokens: outputTokens,
    cumulativeOccupancy: occupancy,
    metaCalls,
    correctToolCalls: correct,
    expectedToolCalls: sc.expected.length,
    hallucinatedNames: hallucinated,
    malformedArgs: malformed,
    taskSuccess: correct === sc.expected.length,
    wallMs: Date.now() - started,
    costUsd: usd,
    error,
    ...(rejects.length ? { rejects } : {}),
  };
}

async function main() {
  const arg = (n: string, d?: string) =>
    process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;

  const which = arg("provider", "all")!;
  const reps = Number(arg("reps", "3"));
  const suiteName = arg("suite", "accuracy")!;
  const only = arg("scenario");

  const suite: Scenario[] =
    suiteName === "tokens"
      ? SCENARIOS
      : suiteName === "both"
        ? [...SCENARIOS, ...ACCURACY_SCENARIOS]
        : ACCURACY_SCENARIOS;
  const scenarios = only ? suite.filter((s) => s.id === only) : suite;

  const providers = await loadProviders(which);
  if (!providers.length) {
    console.error("no providers loaded");
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  console.log(
    `providers=${providers.map((p) => `${p.id}(${p.model})`).join(" ")}\n` +
      `arms=${ACTIVE_ARMS.map((a) => a.id).join(",")} ` +
      `scenarios=${scenarios.length} reps=${reps} suite=${suiteName}\n`,
  );

  for (const provider of providers) {
    const path = `${OUT_DIR}multi-${provider.id}-${stamp}.jsonl`;
    console.log(`\n════ ${provider.id} — ${provider.model}`);

    for (const sc of scenarios) {
      console.log(`\n━━ ${sc.id} (${sc.tools.length} tools)`);
      for (const arm of ACTIVE_ARMS) {
        let block = 0;
        try {
          const c = arm.compile(sc.tools);
          block = await provider.measureToolBlock(
            c.tools as WireTool[],
            c.systemPreamble,
          );
        } catch (e: any) {
          console.log(
            `   ${arm.id.padEnd(11)} measureToolBlock failed: ${e.message?.split("\n")[0]?.slice(0, 80)}`,
          );
        }
        for (let rep = 1; rep <= reps; rep++) {
          const r = await runOne(provider, arm, sc, rep);
          r.toolBlockTokens = block;
          appendFileSync(path, JSON.stringify(r) + "\n");
          console.log(
            `   ${arm.id.padEnd(11)} rep${rep} block=${String(block).padStart(6)} ` +
              `prompt=${String(r.totalPromptTokens).padStart(7)} turns=${String(r.turns).padStart(2)} ` +
              `acc=${r.correctToolCalls}/${r.expectedToolCalls} meta=${r.metaCalls} ` +
              `halluc=${r.hallucinatedNames} bad=${r.malformedArgs} ` +
              `$${r.costUsd.toFixed(4)} ${r.wallMs}ms` +
              (r.error ? `  ERR:${r.error.slice(0, 60)}` : ""),
          );
        }
      }
    }
    console.log(`\nwrote ${path}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
