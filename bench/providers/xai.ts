/**
 * xAI (Grok) provider adapter.
 *
 * xAI serves an OpenAI-compatible Chat Completions API at https://api.x.ai/v1,
 * so we drive it with the `openai` npm client and a swapped baseURL.
 *
 * Endpoint choice, verified 2026-07-25 against https://docs.x.ai/docs/api-reference:
 * xAI exposes BOTH `POST /v1/chat/completions` and a native `POST /v1/responses`
 * (plus /v1/responses/compact and GET/DELETE /v1/responses/{id}). The API
 * reference lists chat completions as a first-class, non-deprecated inference
 * endpoint, and https://docs.x.ai/docs/guides/function-calling documents tool
 * use on the OpenAI-compatible path with an `OpenAI()` client pointed at
 * base_url https://api.x.ai/v1. There is no statement anywhere in the docs
 * preferring /v1/responses for function calling. We therefore stay on chat
 * completions: it is fully supported, and it keeps this adapter's wire shape
 * identical to the OpenAI arm, which is the point of a like-for-like benchmark.
 * (/v1/responses' advantage is server-side context management, which the
 * harness does not want -- it owns the message list.)
 *
 * Model selection and all token/pricing claims below were verified against the
 * live API and current docs on 2026-07-25, not from memory. See the deviations
 * block for the ways xAI's "OpenAI-compatible" surface is not, in fact,
 * identical to OpenAI's.
 */

import "dotenv/config";
import OpenAI from "openai";
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  Provider,
  ToolCall,
  Usage,
  WireTool,
} from "./types.js";

const BASE_URL = "https://api.x.ai/v1";

/**
 * Verified frontier model, 2026-07-25.
 *
 * Reconciled a live `GET /v1/language-models` listing against
 * https://docs.x.ai/docs/models. The live endpoint returns exactly six text
 * models: grok-4.20-0309-non-reasoning, grok-4.20-0309-reasoning,
 * grok-4.20-multi-agent-0309, grok-4.3, grok-4.5, grok-build-0.1. Nothing
 * newer than grok-4.5 exists, so there is nothing to switch to.
 *
 * `grok-4.5` is the flagship on all three independent signals:
 *   - newest `created` of any model (1782691200; next newest is grok-4.3 at
 *     1776384000, then grok-build-0.1 at 1776297600);
 *   - highest price tier by a wide margin ($2.00/$6.00 per M vs $1.25/$2.50
 *     for the whole grok-4.3 / grok-4.20 family and $1.00/$2.00 for
 *     grok-build-0.1) -- xAI prices its best model highest;
 *   - docs.x.ai/docs/models calls Grok 4.5 "the most intelligent and fastest
 *     model we've built" and recommends it for code, chat and general tasks.
 * Deliberately NOT grok-build-0.1 (aka grok-code-fast-1), the cheap fast tier,
 * nor grok-4.20-multi-agent (a different product shape: its reasoning effort
 * selects an agent count, not reasoning depth).
 *
 * Pinned to the concrete id on purpose. TRAP: `grok-latest` is an alias of
 * grok-4.3, NOT of grok-4.5 -- using it would silently benchmark the older,
 * cheaper model. grok-4.5's own aliases are `grok-4.5-latest` and
 * `grok-build-latest`. Concrete id => reproducible numbers.
 *
 * Context window 500k (grok-4.3 and the 4.20 family are 1M; grok-4.5 trades
 * window for capability). Irrelevant at this benchmark's prompt sizes.
 */
const MODEL = "grok-4.5";

/**
 * Reasoning effort, verified empirically 2026-07-25. See REASONING below.
 *
 * "high" so this arm is a like-for-like frontier comparison with the Anthropic
 * arm, which runs at high reasoning effort. Sent explicitly rather than relying
 * on the documented default, because the docs contradict each other about what
 * that default is (see REASONING) and an explicit value is reproducible.
 */
const REASONING_EFFORT = "high" as const;

/* -------------------------------------------------------------------------
 * REASONING: is effort settable on grok-4.5, and at what values?
 * -------------------------------------------------------------------------
 * YES -- settable, and we set it. Establishing this took empirical work
 * because the two relevant doc pages disagree.
 *
 * What the docs say:
 *   - https://docs.x.ai/docs/guides/reasoning has a support table listing
 *     grok-4.5 with `reasoning.effort` of "low"/"medium"/"high" (marked
 *     default), and states verbatim: "If not specified, `reasoning_effort`
 *     defaults to \"high\". Reasoning cannot be disabled." It lists
 *     grok-4.20-multi-agent separately with an extra "xhigh", where effort
 *     controls agent count (4 or 16) rather than depth.
 *   - https://docs.x.ai/docs/api-reference contradicts this for the chat
 *     completions parameter, describing `reasoning_effort` as "Only supported
 *     by `grok-4.3`. Possible values are `none`, `low` (default), `medium` and
 *     `high`". That text is stale/generic: it is wrong about grok-4.5 not
 *     being supported AND wrong about the default (both disproved below).
 *
 * What the live API actually does (grok-4.5, /v1/chat/completions, flat
 * `reasoning_effort` param -- the nested `reasoning: {effort}` form from the
 * guide's table is also accepted but is the /v1/responses shape):
 *   effort=low     -> reasoning_tokens   933
 *   effort=medium  -> reasoning_tokens  5051
 *   effort=high    -> reasoning_tokens  2054
 *   omitted        -> reasoning_tokens  1980
 *   effort=none    -> HTTP 400, verbatim: "This model does not support
 *                     `reasoning_effort` value `none`."
 *   effort=BOGUSZZZ-> HTTP 400, verbatim: "Invalid reasoning effort."
 * (one sample each, identical hard combinatorics prompt, max_tokens 30000)
 *
 * Conclusions:
 *   1. The parameter is genuinely honoured on grok-4.5 -- it is not ignored.
 *      low (933) is unambiguously below every other setting, and unknown
 *      values are rejected rather than silently dropped, so the server really
 *      does parse and act on it. The api-reference "only grok-4.3" line is
 *      simply wrong.
 *   2. Reasoning cannot be disabled, exactly as the guide says: "none" is
 *      rejected for this model with the error quoted above. grok-4.5 always
 *      reasons, which is why the token accounting below matters so much.
 *   3. The default is "high", matching the reasoning guide and contradicting
 *      the api-reference: omitted (1980) tracks high (2054), not low (933).
 *      So setting "high" does not change the effective effort -- but it does
 *      pin it, which is what a published benchmark needs.
 *   4. medium (5051) came out ABOVE high (2054) in this single sample. Do not
 *      read that as an ordering: reasoning length is stochastic per sample and
 *      n=1. It is only evidence that the knob moves, not that medium > high.
 *   5. The accepted enum is a superset of the documented one: "xhigh" and
 *      "minimal" are accepted (HTTP 200) on grok-4.5 even though the docs list
 *      neither for this model, presumably clamped. We stick to the documented
 *      "high" rather than trying to buy extra thinking with an undocumented
 *      "xhigh" that may be silently clamped anyway.
 *   6. `reasoning_effort` does NOT change prompt_tokens (213/219/248 were
 *      identical across every effort for a given prompt), which is what makes
 *      it safe for measureToolBlock to probe at a cheaper effort.
 * ---------------------------------------------------------------------- */

/**
 * Pricing verified 2026-07-25 against two independent sources that agree, plus
 * a third arithmetic check against what xAI actually billed.
 *
 *   1. https://docs.x.ai/docs/models pricing table, grok-4.5, <200k prompt:
 *      $2.00/M input, $0.30/M cached input, $6.00/M output.
 *   2. The live `GET /v1/language-models` entry for grok-4.5:
 *        prompt_text_token_price                 20000
 *        cached_prompt_text_token_price           3000
 *        completion_text_token_price             60000
 *        prompt_text_token_price_long_context    40000
 *        cached_..._long_context                  6000
 *        completion_..._long_context            120000
 *        long_context_threshold                 200000
 *      These integers are TICKS PER TOKEN, where 1 tick = 1e-10 USD -- the same
 *      unit as `usage.cost_in_usd_ticks`. Check: 20000 ticks/token = 2e-6
 *      USD/token = $2.00 per million, matching the docs table exactly. (An
 *      earlier revision of this file claimed the unit was "hundred-thousandths
 *      of a dollar per million tokens"; that would make it $0.20/M and is wrong
 *      by 10x. The tick reading is the one that reconciles -- see deviation 1.)
 *   3. Arithmetic reconciliation against billed `cost_in_usd_ticks` on live
 *      responses, exact to the tick. See deviation 1.
 *
 * LONG-CONTEXT TIER: yes, the rate changes. Every rate exactly DOUBLES once a
 * prompt reaches long_context_threshold = 200,000 tokens ($4.00/M input,
 * $0.60/M cached, $12.00/M output). This is a per-request cliff keyed on prompt
 * size, not a blended rate. The benchmark's prompts are ~200-400 tokens, three
 * orders of magnitude below the threshold, so the short-context rate is the
 * correct one here. If you ever bench 200k+ prompts, these two constants
 * understate cost by exactly 2x and must be switched to the _long_context
 * fields. Nothing in this adapter detects the cliff automatically.
 *
 * Cached input is discounted to $0.30/M (0.15x the $2.00/M uncached rate), and
 * xAI caches unconditionally -- cachedTokens is never 0 in practice (deviation
 * 3). We therefore report it via the interface's optional `priceCachedIn` so the
 * runner bills the cached slice at the real rate; pricing off priceIn alone
 * would systematically OVERstate this arm's spend.
 */
const PRICE_IN_PER_MTOK = 2.0;
const PRICE_CACHED_IN_PER_MTOK = 0.3;
const PRICE_OUT_PER_MTOK = 6.0;

/* -------------------------------------------------------------------------
 * xAI deviations from OpenAI compatibility (found empirically, 2026-07-25,
 * by diffing raw `chat.completions.create` responses from api.x.ai)
 * -------------------------------------------------------------------------
 * 1. THE IMPORTANT ONE: `usage.completion_tokens` EXCLUDES reasoning tokens.
 *    CONFIRMED, independently of the previous agent's finding, 2026-07-25.
 *    OpenAI includes reasoning tokens in `completion_tokens`; xAI reports them
 *    separately in `usage.completion_tokens_details.reasoning_tokens` and adds
 *    them on top. grok-4.5 always reasons and cannot be told not to (see
 *    REASONING above), so `completion_tokens` alone badly under-reports billed
 *    output -- on short answers reasoning dominates it by ~8x. We therefore
 *    report `outputTokens = completion_tokens + reasoning_tokens`, which is what
 *    xAI actually bills, and which matches how the Anthropic/OpenAI adapters
 *    count thinking/reasoning output.
 *
 *    Two independent proofs, both on live grok-4.5 responses:
 *
 *    (a) The identity `total_tokens == prompt + completion + reasoning` holds
 *        exactly, i.e. reasoning is a separate addend, not a subset of
 *        completion. Observed: 213+7+59 == 279; 213+1+24 == 238;
 *        219+1+66 == 286. If reasoning were inside completion, total would
 *        have come out 59/24/66 lower than it did.
 *
 *    (b) Arithmetic reconciliation against xAI's own billed
 *        `usage.cost_in_usd_ticks` (a non-OpenAI field; 1 tick = 1e-10 USD),
 *        using the per-token tick prices from /v1/language-models
 *        (in 20000, cached 3000, out 60000):
 *
 *        Sample A -- prompt 213, cached 128, completion 7, reasoning 59:
 *          (213-128)*20000 +   128*3000 + (7+59)*60000
 *          =    1_700_000 +    384_000 +    3_960_000  =   6_044_000 ticks
 *          actual cost_in_usd_ticks                    =   6_044_000  EXACT
 *          completion-only would predict (7*60000)     =   2_504_000  WRONG
 *
 *        Sample B -- prompt 213, cached 128, completion 1, reasoning 24
 *        (max_tokens:1, finish_reason "length"):
 *          (213-128)*20000 + 128*3000 + (1+24)*60000   =   3_584_000 ticks
 *          actual                                      =   3_584_000  EXACT
 *          completion-only                             =   2_144_000  WRONG
 *
 *        Sample C -- effort=high hard prompt, prompt 248, cached 128,
 *        completion 853, reasoning 2054:
 *          (248-128)*20000 + 128*3000 + (853+2054)*60000 = 177_204_000 ticks
 *          actual                                        = 177_204_000  EXACT
 *
 *        Sample D -- effort=low, prompt 248, cached 128, completion 646,
 *        reasoning 933:
 *          (248-128)*20000 + 128*3000 + (646+933)*60000  =  97_524_000 ticks
 *          actual                                        =  97_524_000  EXACT
 *
 *    Four exact reconciliations, zero mismatches; `completion_tokens` alone
 *    reconciles in none of them. This simultaneously confirms the token
 *    accounting AND the tick unit AND the $2.00/$0.30/$6.00 rates.
 *
 * 1b. `max_tokens` does NOT bound reasoning tokens. Sample B above requested
 *    max_tokens:1 and was still billed 24 reasoning tokens on top, returning
 *    finish_reason "length". So max_tokens caps only the visible completion,
 *    and no max_tokens value makes a grok-4.5 call reasoning-free. Relevant to
 *    the cheap probe in measureToolBlock: it is cheap, but not free.
 * 2. `message.reasoning_content` is an extra field carrying the chain of
 *    thought. On a tool-call turn `content` is "" while `reasoning_content`
 *    holds text. We deliberately drop it: `ChatResult.text` is the visible
 *    answer, not the trace.
 * 3. `usage.prompt_tokens_details` uses xAI's own shape -- `text_tokens`,
 *    `image_tokens`, `audio_tokens`, `cached_tokens`. `cached_tokens` is the
 *    only OpenAI-compatible key. Note the automatic prompt cache appears to
 *    work at a 128-token granularity and reports a non-zero `cached_tokens`
 *    (128) even on a cold minimal prompt, so cachedTokens > 0 is NOT proof of
 *    a meaningful cache hit here. There is no explicit cache-control knob.
 * 4. Extra usage keys OpenAI never sends: `num_sources_used`,
 *    `cost_in_usd_ticks`.
 * 5. `tool_choice: "none"` is NOT free: it injects an extra instruction into
 *    the prompt worth ~13 tokens on top of the tool block. Measuring the tool
 *    block with `"none"` therefore overstates it (265 vs a ground truth of
 *    249 for the same tool set); `"auto"` gives 252. `measureToolBlock` uses
 *    `"auto"` so the probe matches what `chat()` actually sends.
 * 6. `finish_reason` and the assistant-turn shape are OpenAI-faithful, contrary
 *    to what you might expect: xAI does return "tool_calls" on tool-call turns,
 *    and it accepts an assistant tool_calls message with the `content` key
 *    omitted entirely. We still send `content: ""` and still derive
 *    stopReason from the tool calls first, defensively.
 * 7. Both `max_tokens` and `max_completion_tokens` are accepted. We send
 *    `max_tokens` (what the xAI docs use). `max_tokens: 1` is accepted, which
 *    is what makes the measure-by-difference probe cheap.
 * 8. `models.list()` returns non-OpenAI keys per model: `aliases`,
 *    `context_length`, and per-token price fields. Those price fields are in
 *    TICKS PER TOKEN (1e-10 USD), not the 1e-5-USD-per-million unit an earlier
 *    revision of this file claimed -- see the PRICE_* block. There is also a
 *    richer non-OpenAI sibling endpoint, `GET /v1/language-models`, which
 *    returns the same models plus `fingerprint`, `input_modalities`,
 *    `output_modalities` and the long-context price fields.
 *      Aliases are not stable ids, so we pin the concrete id. TRAP worth
 *    repeating: `grok-latest` resolves to grok-4.3, not to grok-4.5.
 * 9. `reasoning_effort` is supported and honoured (unlike what the api-reference
 *    page claims), rejects "none" for grok-4.5, and rejects unknown strings.
 *    Full evidence in the REASONING block above.
 * ---------------------------------------------------------------------- */

const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: BASE_URL,
});

/** Anthropic-shaped tool defs -> OpenAI function tools. */
function toOpenAITools(tools: WireTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

/** `system` + `systemPreamble`, blank line between. Preamble omitted if empty. */
function buildSystemText(system: string, systemPreamble: string): string {
  const a = (system ?? "").trim();
  const b = (systemPreamble ?? "").trim();
  if (a && b) return `${a}\n\n${b}`;
  return a || b;
}

function toOpenAIMessages(
  system: string,
  systemPreamble: string,
  messages: ChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  const sys = buildSystemText(system, systemPreamble);
  if (sys) out.push({ role: "system", content: sys });

  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      out.push({
        role: "assistant",
        // Deviation 6: xAI tolerates a missing key, but send a string anyway.
        content: m.text ?? "",
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: {
            name: c.name,
            arguments: JSON.stringify(c.args ?? {}),
          },
        })),
      });
      continue;
    }
    // tool_results -> one {role:"tool"} message per result.
    for (const r of m.results) {
      out.push({
        role: "tool",
        tool_call_id: r.id,
        content: r.isError ? `ERROR: ${r.content}` : r.content,
      });
    }
  }

  return out;
}

/** `arguments` is a JSON string on the wire; never throw on bad JSON. */
function parseArgs(raw: string | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractToolCalls(message: any): ToolCall[] {
  const raw = message?.tool_calls;
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const tc of raw) {
    // Guard against the newer "custom" tool-call variant in the OpenAI types.
    if (tc?.type && tc.type !== "function") continue;
    if (!tc?.function) continue;
    calls.push({
      id: String(tc.id ?? ""),
      name: String(tc.function.name ?? ""),
      args: parseArgs(tc.function.arguments),
    });
  }
  return calls;
}

/**
 * Normalise xAI usage into `Usage`, with `outputTokens` = ALL BILLED output.
 *
 * Deviation 1: reasoning tokens are billed as output but reported OUTSIDE
 * `completion_tokens`, so they must be added back. Verified to the tick against
 * `cost_in_usd_ticks` on four live samples -- see deviation 1 for the arithmetic.
 */
function extractUsage(usage: any): Usage {
  const completion = num(usage?.completion_tokens);
  const reasoning = num(usage?.completion_tokens_details?.reasoning_tokens);
  return {
    promptTokens: num(usage?.prompt_tokens),
    outputTokens: completion + reasoning,
    // Deviation 3: xAI reports the cached slice here; 0 when it does not.
    cachedTokens: num(usage?.prompt_tokens_details?.cached_tokens),
  };
}

/** Coerce a possibly-missing/garbage usage field to a finite non-negative int. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function normaliseStopReason(
  finishReason: string | null | undefined,
  toolCalls: ToolCall[],
  refusal: string | null | undefined,
): string {
  // Tool calls win regardless of what finish_reason says (see deviation 6).
  if (toolCalls.length > 0) return "tool_use";
  if (refusal) return "refusal";
  switch (finishReason) {
    case "tool_calls":
      return "tool_use";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return finishReason ?? "end_turn";
  }
}

export const xaiProvider: Provider = {
  id: "xai",
  model: MODEL,
  priceIn: PRICE_IN_PER_MTOK / 1_000_000,
  priceCachedIn: PRICE_CACHED_IN_PER_MTOK / 1_000_000,
  priceOut: PRICE_OUT_PER_MTOK / 1_000_000,

  async chat(req: ChatRequest): Promise<ChatResult> {
    const tools = toOpenAITools(req.tools);
    const resp = await client.chat.completions.create({
      model: MODEL,
      max_tokens: req.maxTokens,
      // Verified settable and honoured on grok-4.5; see the REASONING block.
      // Explicit "high" for parity with the Anthropic arm.
      reasoning_effort: REASONING_EFFORT,
      messages: toOpenAIMessages(req.system, req.systemPreamble, req.messages),
      ...(tools.length ? { tools, tool_choice: "auto" as const } : {}),
    });

    const choice = resp.choices?.[0];
    const message: any = choice?.message ?? {};
    const toolCalls = extractToolCalls(message);
    const refusal: string | null | undefined = message.refusal;

    return {
      toolCalls,
      text: typeof message.content === "string" ? message.content : (refusal ?? ""),
      usage: extractUsage(resp.usage),
      stopReason: normaliseStopReason(choice?.finish_reason, toolCalls, refusal),
    };
  },

  /**
   * No token-counting endpoint on xAI, so measure by difference: the same
   * minimal request with tools + preamble minus the one without, using the
   * server-reported prompt token counts. Two cheap calls (max_tokens: 1).
   *
   * Uses tool_choice "auto", exactly as chat() does -- see deviation 5, using
   * "none" would silently add ~13 tokens of steering text to the measurement.
   * The residual error is ~3 tokens (the system-message envelope, which the
   * no-preamble control does not pay); measured 252 against a ground truth of
   * 249 for a 3-tool block.
   *
   * Probes at reasoning_effort "low", NOT the "high" that chat() uses. This is
   * safe and deliberate: effort provably does not affect prompt_tokens (verified
   * identical prompt_tokens across every effort value -- REASONING point 6), and
   * prompt_tokens is the only thing this function reads. Since reasoning cannot
   * be disabled and max_tokens does not bound it (deviation 1b), "low" is the
   * cheapest the two probe calls can be made.
   */
  async measureToolBlock(tools: WireTool[], systemPreamble: string): Promise<number> {
    const probe = "x";
    const baseArgs = {
      model: MODEL,
      max_tokens: 1,
      reasoning_effort: "low",
    } as const;

    const withTools = await client.chat.completions.create({
      ...baseArgs,
      messages: toOpenAIMessages("", systemPreamble, [{ role: "user", content: probe }]),
      ...(tools.length
        ? { tools: toOpenAITools(tools), tool_choice: "auto" as const }
        : {}),
    });

    const withoutTools = await client.chat.completions.create({
      ...baseArgs,
      messages: toOpenAIMessages("", "", [{ role: "user", content: probe }]),
    });

    const diff =
      (withTools.usage?.prompt_tokens ?? 0) - (withoutTools.usage?.prompt_tokens ?? 0);
    return Math.max(0, diff);
  },
};

export default xaiProvider;
