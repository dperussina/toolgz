/**
 * OpenAI provider adapter for the benchmark harness.
 *
 * Translates the Anthropic-shaped wire format the arms emit
 * (`{name, description, input_schema}`) into OpenAI's **Responses API**
 * function-tool format, and normalises the response back into `ChatResult`.
 *
 * ===========================================================================
 * WHY /v1/responses AND NOT /v1/chat/completions
 * ===========================================================================
 * The previous revision of this file targeted `/v1/chat/completions`, where the
 * GPT-5.x line refuses to combine function tools with reasoning. Verbatim
 * error, reproduced live on gpt-5.6-sol / -terra / gpt-5.5 / gpt-5.4:
 *
 *   "Function tools with reasoning_effort are not supported for gpt-5.6-sol in
 *    /v1/chat/completions. To use function tools, use /v1/responses or set
 *    reasoning_effort to 'none'."
 *
 * That forced `reasoning_effort: "none"` on every tool-carrying turn, which is
 * a benchmark-invalidating confound: the Anthropic arm runs at
 * `output_config.effort: "high"` (see bench/providers/anthropic.ts:91).
 *
 * This revision ports the adapter to `/v1/responses`, where tools + reasoning
 * DO work together. Verified live on 2026-07-25 with gpt-5.6-sol at
 * `reasoning.effort` = "high", "xhigh" and "max": all three returned HTTP 200
 * with a `function_call` output item, and the "max" run reported
 * `output_tokens_details.reasoning_tokens: 13`. There is no restriction to
 * report — reasoning is genuinely active alongside tools now.
 *
 * ===========================================================================
 * DOCUMENTATION CONSULTED (fetched 2026-07-25, not recalled from memory)
 * ===========================================================================
 * - https://developers.openai.com/api/docs/guides/function-calling
 *     (platform.openai.com/docs/guides/function-calling 301-redirects here)
 * - https://developers.openai.com/api/docs/guides/reasoning
 * - openai npm SDK 6.49.0 type definitions, which are generated from the
 *   OpenAPI spec and are therefore the authoritative wire contract. The
 *   platform.openai.com API-reference HTML returns 403 to plain fetches, so the
 *   generated types + live calls were used instead.
 *
 * Findings, each one exercised against the live API:
 *
 * 1. TOOL SHAPE IS FLAT. Confirmed. On Responses it is
 *      {type:"function", name, description, parameters, strict?}
 *    NOT the Chat Completions shape `{type:"function", function:{...}}`.
 *    SDK: `OpenAI.Responses.FunctionTool` (resources/responses/responses.d.ts).
 *    `strict` is typed `boolean | null` but may be OMITTED on the wire; we omit
 *    it, because the arms' `input_schema` is not guaranteed to satisfy strict
 *    mode (which requires `additionalProperties:false` and every property in
 *    `required`).
 *
 * 2. CONVERSATION HISTORY IS A FLAT `input[]` ITEM LIST, not a message list.
 *    - user/developer/system text:  {role, content}
 *    - a model tool call:           {type:"function_call", call_id, name,
 *                                    arguments /* JSON string *\/, id?, status?}
 *    - the result you feed back:    {type:"function_call_output", call_id,
 *                                    output /* string *\/}
 *    Note the id field is `call_id` on BOTH, and the result field is `output`
 *    (Chat Completions used `tool_call_id` + `content`). There is no
 *    `role:"tool"` item. Verified field names against
 *    `ResponseFunctionToolCall` and `ResponseInputItem.FunctionCallOutput`.
 *
 * 3. REASONING ITEMS MUST BE ECHOED BACK. The function-calling guide says
 *    verbatim: "Note that for reasoning models like GPT-5 or o4-mini, any
 *    reasoning items returned in model responses with tool calls must also be
 *    passed back with tool call outputs." The reasoning guide repeats it.
 *    Reasoning items look like {type:"reasoning", id, summary:[],
 *    encrypted_content:"gAAAA..."} and we round-trip them VERBATIM through the
 *    harness's `ChatMessage.raw` channel (that field exists in types.ts for
 *    exactly this reason). We request `include:["reasoning.encrypted_content"]`
 *    so the items are self-contained and usable with `store:false`.
 *    Verified: a turn-2 request carrying [user, reasoning, function_call,
 *    function_call_output] returned HTTP 200 and a normal text answer.
 *
 * 4. REASONING EFFORT is `reasoning: {effort: ...}` (an object), not the
 *    Chat Completions top-level `reasoning_effort`. Valid values per the
 *    reasoning guide and `Shared.ReasoningEffort`:
 *      'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
 *    (model-dependent; gpt-5.6-sol accepted high, xhigh and max here).
 *    *** WE PIN "high" *** — see REASONING EFFORT CHOICE below.
 *    `reasoning.context` also exists ('auto' | 'current_turn' | 'all_turns');
 *    the response echoed `context:"all_turns"` for gpt-5.6-sol, i.e. reasoning
 *    from every prior turn is rendered back. We deliberately leave it at the
 *    model default because that mirrors the Anthropic arm, which returns all
 *    prior thinking blocks unchanged.
 *
 * 5. USAGE FIELD NAMES ARE DIFFERENT from Chat Completions:
 *      usage.input_tokens                          (was prompt_tokens)
 *      usage.input_tokens_details.cached_tokens    (was
 *                                   prompt_tokens_details.cached_tokens)
 *      usage.input_tokens_details.cache_write_tokens   (new; not billed as
 *                                   extra input, informational only)
 *      usage.output_tokens                         (was completion_tokens)
 *      usage.output_tokens_details.reasoning_tokens
 *      usage.total_tokens
 *    Reasoning tokens are BILLED AS OUTPUT TOKENS and are already included in
 *    `output_tokens` — the reasoning guide: "they still occupy space in the
 *    model's context window and are billed as output tokens". Verified
 *    arithmetically on a live call: input 59 + output 33 = total 92, with
 *    reasoning_tokens 13 inside that 33. So `outputTokens = output_tokens` is
 *    correct and must NOT have reasoning_tokens added to it.
 *    `cached_tokens` is INCLUDED in `input_tokens`, which matches this
 *    harness's `Usage` contract. Verified live with a 4.7k-token repeated
 *    prefix: {input_tokens: 4746, cached_tokens: 4671} on the second call —
 *    4746 is the full count, not 4746+4671.
 *
 * 6. SDK SURFACE: yes, `client.responses.create(...)` exists (openai 6.49.0,
 *    `OpenAI.Responses`). Non-streaming by default. Also present:
 *    `client.responses.inputTokens.count(...)`, a real token-counting endpoint
 *    for this API — see measureToolBlock for why we do not use it.
 *
 * 7. `max_output_tokens` (NOT `max_tokens`, NOT `max_completion_tokens`) is the
 *    budget parameter, and it has a hard minimum. Verbatim 400:
 *      "Invalid 'max_output_tokens': integer below minimum value. Expected a
 *       value >= 16, but got 1 instead."
 *    Like the Chat Completions budget it covers reasoning tokens as well as
 *    visible output. Exceeding it yields `status:"incomplete"` with
 *    `incomplete_details.reason:"max_output_tokens"` rather than a throw.
 *
 * 8. `temperature` is still rejected for any non-default value on this model,
 *    so we never send it.
 *
 * 9. `store:false` is safe: prompt caching still works (verified — see 5), and
 *    it keeps the benchmark stateless so no run can accidentally depend on
 *    server-side conversation state. We therefore never use
 *    `previous_response_id`, even though the reasoning guide recommends it as
 *    the "simplest" way to preserve reasoning across turns; the harness owns
 *    the transcript and replays it explicitly.
 *
 * ===========================================================================
 * MODEL CHOICE
 * ===========================================================================
 * `gpt-5.6-sol` — retained. Re-confirmed present in a live `models.list()` and
 * confirmed to work on `/v1/responses` (the `*-pro` tiers' "This is not a chat
 * model" 404 was a Chat-Completions-only restriction; it does not apply in
 * reverse, gpt-5.6-sol is fine on Responses). In the 5.6 naming scheme the
 * number is the generation and the suffix is the capability tier:
 * Sol (flagship) > Terra (balanced) > Luna (cheap).
 *
 * ===========================================================================
 * REASONING EFFORT CHOICE: "high"
 * ===========================================================================
 * Pinned to "high" for like-for-like parity with the Anthropic arm, which pins
 * `output_config: {effort: "high"}`. "xhigh" and "max" both work on this model
 * and would spend more reasoning tokens, but "high" is the value that makes the
 * two frontier arms comparable, which is the entire point of the fix.
 * Overridable with OPENAI_REASONING_EFFORT for sensitivity runs.
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

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseFunctionTool = OpenAI.Responses.FunctionTool;
type ResponseOutputItem = OpenAI.Responses.ResponseOutputItem;
type ReasoningEffort = OpenAI.ReasoningEffort;

/** Frontier / flagship tier of the current generation. See MODEL CHOICE above. */
const MODEL = "gpt-5.6-sol";

/**
 * Reasoning effort actually sent. See REASONING EFFORT CHOICE above.
 * Anthropic arm parity value; not the maximum the model supports.
 */
const DEFAULT_EFFORT: ReasoningEffort = "high";

/**
 * Pricing verified 2026-07-25 against OpenAI's published API pricing page
 * (platform.openai.com/docs/pricing -> developers.openai.com/api/docs/pricing):
 *   gpt-5.6-sol  $5.00 / 1M input, $0.50 / 1M cached input, $30.00 / 1M output.
 * The Provider interface wants $ per single token, so divide by 1e6.
 */
const PRICE_IN_PER_MTOK = 5.0;
const PRICE_OUT_PER_MTOK = 30.0;
/** Cached input bills at 10% of input. Not part of the Provider interface, but
 *  exported so cost models that care about prefix caching can use it. */
export const OPENAI_PRICE_CACHED_IN = 0.5 / 1_000_000;

/** Hard API floor for max_output_tokens — see finding 7. */
const MIN_OUTPUT_TOKENS = 16;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Optional effort pin, e.g. OPENAI_REASONING_EFFORT=xhigh. Unlike the previous
 * Chat Completions adapter this is honoured on EVERY turn, tool-carrying or
 * not, because Responses has no tools-vs-reasoning conflict.
 */
function effort(): ReasoningEffort {
  const v = process.env.OPENAI_REASONING_EFFORT?.trim();
  return v ? (v as ReasoningEffort) : DEFAULT_EFFORT;
}

/**
 * Anthropic-shaped tool -> Responses function tool. FLAT, no `function:` nest
 * (finding 1). `strict` intentionally omitted.
 */
function toResponsesTools(tools: WireTool[]): ResponseFunctionTool[] {
  return tools.map(
    (t) =>
      ({
        type: "function",
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.input_schema as Record<string, unknown>,
      }) as ResponseFunctionTool,
  );
}

/**
 * `system` + `systemPreamble` concatenate, preamble last, separated by a blank
 * line. An empty preamble is omitted entirely (no trailing whitespace, so the
 * token count of the no-preamble case is genuinely the baseline).
 */
function joinSystem(system: string, systemPreamble: string): string {
  const a = system ?? "";
  const b = systemPreamble ?? "";
  if (!b.trim()) return a;
  if (!a.trim()) return b;
  return `${a}\n\n${b}`;
}

/** OpenAI hands back `arguments` as a JSON string. Never throw on bad JSON. */
function parseArgs(raw: string | undefined | null): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : {};
  } catch {
    return {};
  }
}

/**
 * ChatMessage[] -> Responses `input[]`.
 *
 * The system text goes in as a `developer`-role item rather than the top-level
 * `instructions` parameter. Verified equivalent in token cost (17 input tokens
 * either way for the same string), and keeping it inside `input` means the
 * measureToolBlock probes and chat() build their prompts through exactly the
 * same code path.
 */
function toResponsesInput(
  system: string,
  systemPreamble: string,
  messages: ChatMessage[],
): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];

  const sys = joinSystem(system, systemPreamble);
  if (sys.trim()) {
    // "developer" is the reasoning-model spelling of the system role and is
    // what Responses documents; "system" is still accepted.
    out.push({ role: "developer", content: sys });
  }

  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }

    if (m.role === "assistant") {
      // Preferred path: replay the provider-native output items verbatim.
      // This is what preserves the reasoning items (finding 3) — including
      // their `encrypted_content` — so the model does not re-reason from
      // scratch every turn.
      const raw = m.raw;
      if (Array.isArray(raw) && raw.length) {
        for (const item of raw as ResponseOutputItem[]) {
          out.push(item as unknown as ResponseInputItem);
        }
        continue;
      }

      // Fallback for transcripts that carry no `raw` (e.g. replayed from a
      // stored jsonl). Reconstructs the shape but NOT the reasoning items, so
      // the model will re-reason. Correctness preserved, cost is not.
      if (m.text && m.text.trim()) {
        out.push({
          role: "assistant",
          content: [{ type: "output_text", text: m.text, annotations: [] }],
        } as unknown as ResponseInputItem);
      }
      for (const tc of m.toolCalls ?? []) {
        out.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.args ?? {}),
        } as ResponseInputItem);
      }
      continue;
    }

    // tool_results -> one function_call_output item per result, keyed by
    // call_id (finding 2). No role:"tool" message on this API.
    for (const r of m.results) {
      out.push({
        type: "function_call_output",
        call_id: r.id,
        output: r.isError ? `ERROR: ${r.content}` : r.content,
      } as ResponseInputItem);
    }
  }

  return out;
}

/** Responses usage -> harness Usage. Field names per finding 5. */
function readUsage(usage: OpenAI.Responses.ResponseUsage | undefined): Usage {
  return {
    // Total input tokens, cached portion already included.
    promptTokens: usage?.input_tokens ?? 0,
    // Already includes output_tokens_details.reasoning_tokens; adding them
    // again would double-count. See finding 5.
    outputTokens: usage?.output_tokens ?? 0,
    cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
  };
}

/**
 * Normalise to "tool_use" | "end_turn" | "max_tokens" | "refusal" | raw.
 * Tool calls win first, matching bench/providers/anthropic.ts::normaliseStop so
 * the two arms' stopReason columns mean the same thing.
 */
function normaliseStopReason(
  status: string | undefined,
  incompleteReason: string | undefined,
  hasToolCalls: boolean,
  refused: boolean,
): string {
  if (hasToolCalls) return "tool_use";
  if (refused) return "refusal";
  if (status === "incomplete") {
    if (incompleteReason === "max_output_tokens") return "max_tokens";
    if (incompleteReason === "content_filter") return "refusal";
    return incompleteReason ?? "incomplete";
  }
  if (status === "completed") return "end_turn";
  return status ?? "end_turn";
}

/** Pull the harness-visible pieces out of a Responses `output[]` array. */
function readOutput(output: ResponseOutputItem[] | undefined): {
  toolCalls: ToolCall[];
  text: string;
  refusal: string | null;
} {
  const toolCalls: ToolCall[] = [];
  const textParts: string[] = [];
  let refusal: string | null = null;

  for (const item of output ?? []) {
    if (item.type === "function_call") {
      toolCalls.push({
        // call_id, not id: it is what function_call_output must reference.
        id: item.call_id,
        name: item.name ?? "",
        args: parseArgs(item.arguments),
      });
      continue;
    }
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") textParts.push(part.text);
        else if (part.type === "refusal") refusal = part.refusal;
      }
    }
    // "reasoning" items carry no harness-visible text (summary is off); they
    // still travel back to the model via `raw`.
  }

  return { toolCalls, text: textParts.join(""), refusal };
}

/**
 * Input tokens for a minimal probe request, with or without the tool block.
 * Uses `responses.create` — the same endpoint chat() uses — deliberately, so
 * the measured number is exactly what a real turn would be charged for.
 * tool_choice:"none" keeps the probe from spending output tokens on a call;
 * verified not to change input_tokens versus omitting it.
 */
async function probeInputTokens(
  tools: WireTool[] | null,
  systemPreamble: string,
): Promise<number> {
  const input = toResponsesInput("", tools ? systemPreamble : "", [
    { role: "user", content: "ping" },
  ]);

  const res = await client.responses.create({
    model: MODEL,
    input,
    max_output_tokens: MIN_OUTPUT_TOKENS,
    reasoning: { effort: effort() },
    store: false,
    ...(tools && tools.length
      ? { tools: toResponsesTools(tools), tool_choice: "none" as const }
      : {}),
  });

  return res.usage?.input_tokens ?? 0;
}

export const openaiProvider: Provider = {
  id: "openai",
  model: MODEL,
  priceIn: PRICE_IN_PER_MTOK / 1_000_000,
  priceOut: PRICE_OUT_PER_MTOK / 1_000_000,
  // Cached input bills at 0.5/MTok vs 5.0 input (verified in this adapter).
  priceCachedIn: OPENAI_PRICE_CACHED_IN,

  async chat(req: ChatRequest): Promise<ChatResult> {
    const input = toResponsesInput(
      req.system,
      req.systemPreamble,
      req.messages,
    );
    const tools = toResponsesTools(req.tools ?? []);

    let res: OpenAI.Responses.Response;
    try {
      res = await client.responses.create({
        model: MODEL,
        input,
        // max_output_tokens, never max_tokens/max_completion_tokens (finding
        // 7). Budget also covers reasoning tokens. No temperature (finding 8).
        max_output_tokens: Math.max(
          MIN_OUTPUT_TOKENS,
          req.maxTokens || MIN_OUTPUT_TOKENS,
        ),
        // Reasoning ON, alongside tools. This is the whole point of the port.
        reasoning: { effort: effort() },
        // Self-contained reasoning items so they can be replayed with
        // store:false (finding 3 / 9).
        include: ["reasoning.encrypted_content"],
        store: false,
        ...(tools.length ? { tools } : {}),
      });
    } catch (err: any) {
      // The contract says a refusal must surface as a stopReason, not a throw.
      // OpenAI signals prompt-level policy refusals as 400s, so map those; any
      // other failure (auth, rate limit, network) is a real error and rethrows.
      const code = err?.code ?? err?.error?.code ?? "";
      const type = err?.type ?? err?.error?.type ?? "";
      if (
        err?.status === 400 &&
        (String(code).includes("content_policy") ||
          String(code).includes("content_filter") ||
          String(type).includes("invalid_prompt") ||
          String(code).includes("invalid_prompt"))
      ) {
        return {
          toolCalls: [],
          text: String(err?.message ?? "refused"),
          usage: { promptTokens: 0, outputTokens: 0, cachedTokens: 0 },
          stopReason: "refusal",
        };
      }
      throw err;
    }

    const { toolCalls, text, refusal } = readOutput(res.output);

    return {
      toolCalls,
      text: refusal ?? text,
      usage: readUsage(res.usage),
      stopReason: normaliseStopReason(
        res.status,
        res.incomplete_details?.reason,
        toolCalls.length > 0,
        refusal != null,
      ),
      // The full output item list, replayed verbatim next turn so reasoning
      // items survive (finding 3). types.ts documents this exact use.
      raw: res.output,
    };
  },

  /**
   * Measured by difference: two tiny `responses.create` calls, one carrying
   * tools + preamble and one bare, subtracting the reported input tokens.
   *
   * `client.responses.inputTokens.count()` exists and would be free, but it is
   * a separate endpoint whose prompt rendering we have not validated against
   * inference; measuring on the same endpoint chat() uses guarantees the number
   * matches what the benchmark is actually billed for. Cost is ~2 tiny requests
   * per (arm, scenario).
   */
  async measureToolBlock(
    tools: WireTool[],
    systemPreamble: string,
  ): Promise<number> {
    const [withTools, without] = await Promise.all([
      probeInputTokens(tools, systemPreamble),
      probeInputTokens(null, ""),
    ]);
    return Math.max(0, withTools - without);
  },
};

export default openaiProvider;
