import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { ARMS } from "../strategies/index.js";
import { SCENARIOS, type Scenario } from "../scenarios.js";
import { ACCURACY_SCENARIOS } from "../scenarios-accuracy.js";
import type {
  CompressionStrategy,
  ScenarioResult,
  TurnRecord,
} from "../core/types.js";

/**
 * Model registry. Pricing is $/MTok (input, output) at actually-billed rates.
 *
 * `supportsEffort` matters: `output_config.effort` errors on Haiku 4.5, so the
 * knob is omitted there. That is a real confound when comparing Haiku against
 * Opus/Sonnet — Haiku runs without an effort pin while the others are held at
 * "high". Report it; do not quietly treat the arms as identically configured.
 */
const MODELS = {
  "claude-opus-5": { in: 5.0, out: 25.0, supportsEffort: true },
  "claude-sonnet-5": { in: 2.0, out: 10.0, supportsEffort: true }, // intro rate thru 2026-08-31
  "claude-haiku-4-5": { in: 1.0, out: 5.0, supportsEffort: false },
} as const;

type ModelId = keyof typeof MODELS;

const MODEL = (process.argv
  .find((a) => a.startsWith("--model="))
  ?.split("=")[1] ?? "claude-opus-5") as ModelId;

if (!(MODEL in MODELS)) {
  console.error(
    `unknown model: ${MODEL}\nknown: ${Object.keys(MODELS).join(", ")}`,
  );
  process.exit(1);
}

const SPEC = MODELS[MODEL];
const PRICE_IN = SPEC.in / 1_000_000;
const PRICE_OUT = SPEC.out / 1_000_000;
const PRICE_CACHE_WRITE = PRICE_IN * 1.25;
const PRICE_CACHE_READ = PRICE_IN * 0.1;

const client = new Anthropic();
const OUT_DIR = new URL("../results/", import.meta.url).pathname;
mkdirSync(OUT_DIR, { recursive: true });

const SYSTEM_BASE =
  "You are an operations agent with access to tools. Use the tools to complete the user's request. Do not ask clarifying questions — make reasonable assumptions and act. When the task is complete, reply with a one-line summary.";

function cost(u: any): number {
  return (
    (u.input_tokens ?? 0) * PRICE_IN +
    (u.cache_creation_input_tokens ?? 0) * PRICE_CACHE_WRITE +
    (u.cache_read_input_tokens ?? 0) * PRICE_CACHE_READ +
    (u.output_tokens ?? 0) * PRICE_OUT
  );
}

function promptTokens(u: any): number {
  return (
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  );
}

/** Server-side tools are rejected by count_tokens; strip them for measurement. */
const isServerTool = (t: any) => typeof t?.type === "string" && t.type.startsWith("tool_search_");

/**
 * Measure the tool block in isolation.
 *
 * count_tokens honours `defer_loading`, so the number reflects what the model
 * actually holds resident. The server-side search tool itself cannot be passed
 * to count_tokens, so its (small, fixed) definition is excluded — noted in the
 * report rather than silently folded in.
 */
async function measureToolBlock(
  strat: CompressionStrategy,
  sc: Scenario,
): Promise<number> {
  const c = strat.compile(sc.tools);
  const r = await client.messages.countTokens({
    model: MODEL,
    tools: c.tools.filter((t) => !isServerTool(t)) as any,
    system: c.systemPreamble
      ? [{ type: "text", text: SYSTEM_BASE + "\n\n" + c.systemPreamble }]
      : SYSTEM_BASE,
    messages: [{ role: "user", content: "x" }],
  });
  const bare = await client.messages.countTokens({
    model: MODEL,
    system: SYSTEM_BASE,
    messages: [{ role: "user", content: "x" }],
  });
  return r.input_tokens - bare.input_tokens;
}

function argsMatch(expected: Record<string, any> | undefined, actual: any): boolean {
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
  strat: CompressionStrategy,
  sc: Scenario,
  rep: number,
  turnSink: TurnRecord[],
): Promise<ScenarioResult> {
  const compiled = strat.compile(sc.tools);
  const started = Date.now();

  // Cache breakpoint on the last *non-deferred* tool. The API rejects
  // cache_control on a tool carrying defer_loading, and a deferred tool is not
  // part of the resident prefix anyway.
  let bpIdx = -1;
  compiled.tools.forEach((t: any, i) => {
    if (!t.defer_loading && !isServerTool(t)) bpIdx = i;
  });
  const wireTools = compiled.tools.map((t, i) =>
    i === bpIdx ? { ...t, cache_control: { type: "ephemeral" } } : t,
  );

  const system: any = compiled.systemPreamble
    ? [
        { type: "text", text: SYSTEM_BASE },
        {
          type: "text",
          text: compiled.systemPreamble,
          ...(compiled.cachePreamble
            ? { cache_control: { type: "ephemeral" } }
            : {}),
        },
      ]
    : SYSTEM_BASE;

  const messages: any[] = [{ role: "user", content: sc.prompt }];
  const observed: { name: string; args: any }[] = [];
  let metaCalls = 0;
  let hallucinated = 0;
  let malformed = 0;
  let totalPrompt = 0;
  let totalOut = 0;
  let occupancy = 0;
  let usd = 0;
  let turn = 0;
  let err: string | undefined;

  try {
    while (turn < sc.maxTurns) {
      turn++;
      const t0 = Date.now();
      const resp: any = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        // Omitted on models where effort is unsupported (Haiku 4.5 → 400).
        ...(SPEC.supportsEffort
          ? { output_config: { effort: "high" } as any }
          : {}),
        system,
        tools: wireTools as any,
        messages,
      });
      const latency = Date.now() - t0;
      const pt = promptTokens(resp.usage);
      totalPrompt += pt;
      totalOut += resp.usage.output_tokens ?? 0;
      occupancy = pt; // last turn's prompt size == final occupancy
      usd += cost(resp.usage);

      const toolUses = resp.content.filter((b: any) => b.type === "tool_use");

      turnSink.push({
        scenario: sc.id,
        arm: strat.id,
        rep,
        turn,
        input_tokens: resp.usage.input_tokens ?? 0,
        cache_creation_input_tokens: resp.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: resp.usage.cache_read_input_tokens ?? 0,
        output_tokens: resp.usage.output_tokens ?? 0,
        total_prompt_tokens: pt,
        latency_ms: latency,
        stop_reason: resp.stop_reason,
        calls: toolUses.map((t: any) => ({ name: t.name, args: t.input })),
        metaCalls: 0,
      });

      if (resp.stop_reason === "refusal") {
        err = "refusal";
        break;
      }
      if (!toolUses.length) break;

      messages.push({ role: "assistant", content: resp.content });
      const results: any[] = [];

      for (const tu of toolUses) {
        // Native server-side search resolves itself; nothing to feed back.
        if (tu.name === "tool_search_tool_regex") {
          metaCalls++;
          continue;
        }
        const res = strat.resolve(sc.tools, tu.name, tu.input ?? {});
        if (res.kind === "meta") {
          metaCalls++;
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: res.result,
          });
        } else if (res.kind === "error") {
          if (/no such tool|no code|unknown op/.test(res.message)) hallucinated++;
          else malformed++;
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Error: ${res.message}`,
            is_error: true,
          });
        } else {
          observed.push({ name: res.name, args: res.args });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: sc.results[res.name] ?? '{"ok":true}',
          });
        }
      }

      if (!results.length) break; // only server-side calls this turn
      messages.push({ role: "user", content: results });
    }
  } catch (e: any) {
    err = e?.message ?? String(e);
  }

  // Scoring: expected calls must appear in order (subsequence match).
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
    model: MODEL,
    scenario: sc.id,
    arm: strat.id,
    rep,
    toolBlockTokens: 0,
    turns: turn,
    totalPromptTokens: totalPrompt,
    totalOutputTokens: totalOut,
    cumulativeOccupancy: occupancy,
    metaCalls,
    correctToolCalls: correct,
    expectedToolCalls: sc.expected.length,
    hallucinatedNames: hallucinated,
    malformedArgs: malformed,
    taskSuccess: correct === sc.expected.length,
    wallMs: Date.now() - started,
    costUsd: usd,
    error: err,
  };
}

async function main() {
  const only = process.argv.find((a) => a.startsWith("--scenario="))?.split("=")[1];
  const reps = Number(process.argv.find((a) => a.startsWith("--reps="))?.split("=")[1] ?? 2);
  const suite = process.argv.includes("--accuracy") ? ACCURACY_SCENARIOS : SCENARIOS;
  const scenarios = only ? suite.filter((s) => s.id === only) : suite;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Model goes in the filename: results from different models must never be
  // aggregated together by a later glob.
  const tag = `${MODEL}-${stamp}`;
  const turnsPath = `${OUT_DIR}turns-${tag}.jsonl`;
  const resultsPath = `${OUT_DIR}results-${tag}.jsonl`;
  const turnSink: TurnRecord[] = [];
  const results: ScenarioResult[] = [];

  console.log(`model=${MODEL} scenarios=${scenarios.length} arms=${ARMS.length} reps=${reps}\n`);

  for (const sc of scenarios) {
    console.log(`\n━━ ${sc.id} — ${sc.tools.length} tools, ${sc.expected.length} expected calls`);
    for (const arm of ARMS) {
      let block = 0;
      try {
        block = await measureToolBlock(arm, sc);
      } catch (e: any) {
        console.log(`   ${arm.id.padEnd(11)} count_tokens failed: ${e.message}`);
      }
      for (let rep = 1; rep <= reps; rep++) {
        const r = await runOne(arm, sc, rep, turnSink);
        r.toolBlockTokens = block;
        results.push(r);
        appendFileSync(resultsPath, JSON.stringify(r) + "\n");
        const acc = `${r.correctToolCalls}/${r.expectedToolCalls}`;
        console.log(
          `   ${arm.id.padEnd(11)} rep${rep}  block=${String(block).padStart(6)}  ` +
            `prompt=${String(r.totalPromptTokens).padStart(7)}  turns=${String(r.turns).padStart(2)}  ` +
            `acc=${acc}  meta=${r.metaCalls}  halluc=${r.hallucinatedNames}  ` +
            `bad=${r.malformedArgs}  $${r.costUsd.toFixed(4)}  ${r.wallMs}ms` +
            (r.error ? `  ERR:${r.error.slice(0, 60)}` : ""),
        );
      }
    }
  }

  writeFileSync(turnsPath, turnSink.map((t) => JSON.stringify(t)).join("\n"));
  console.log(`\nwrote ${resultsPath}`);
  console.log(`wrote ${turnsPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
