/**
 * Google Gemini provider adapter for the benchmark harness.
 *
 * Translates the Anthropic-shaped `WireTool[]` / `ChatMessage[]` that every arm
 * emits into Gemini's `generateContent` wire format and normalises the response
 * back into `ChatResult`.
 *
 * SDK: `@google/genai` (v2.x). Credentials come from `GEMINI_API_KEY`.
 */
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import type {
  Content,
  FunctionDeclaration,
  GenerateContentResponse,
  Part,
  Schema,
} from "@google/genai";

import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  Provider,
  ToolCall,
  Usage,
  WireTool,
} from "./types.js";

/**
 * Google's current frontier / flagship model.
 *
 * Pro tier (deliberately not Flash or Flash-Lite), 1M-token context, supports
 * function calling. Selected from the model catalogue documented at
 * https://ai.google.dev/gemini-api/docs/models and priced on
 * https://ai.google.dev/gemini-api/docs/pricing.
 */
const MODEL = "gemini-3.1-pro-preview";

/**
 * Pricing verified 2026-07-25 from https://ai.google.dev/gemini-api/docs/pricing
 * (paid Standard tier, `gemini-3.1-pro-preview`):
 *
 *   input  $2.00 / 1M tokens  (prompts <= 200k;  $4.00 above)
 *   output $12.00 / 1M tokens (prompts <= 200k; $18.00 above)
 *
 * The harness wants $ per single token, and benchmark prompts sit far below the
 * 200k long-context threshold, so the short-context rate is the right one.
 */
const PRICE_IN_PER_MTOK = 2.0;
const PRICE_OUT_PER_MTOK = 12.0;

// --------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------

let client: GoogleGenAI | undefined;

function ai(): GoogleGenAI {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set (expected in .env)");
  }
  client = new GoogleGenAI({ apiKey });
  return client;
}

// --------------------------------------------------------------------------
// JSON Schema -> Gemini Schema
// --------------------------------------------------------------------------

/**
 * Gemini's `FunctionDeclaration.parameters` is an OpenAPI 3.03 Schema subset,
 * not full JSON Schema, and the API hard-rejects unknown keywords rather than
 * ignoring them. We therefore allowlist, which is strictly safer than chasing a
 * denylist of whatever the API happens to complain about today.
 *
 * Keys that are consequently stripped include (non-exhaustive):
 *   additionalProperties, $schema, $id, $ref, $defs, definitions, default,
 *   example, examples, const, oneOf, allOf, not, if/then/else, patternProperties,
 *   additionalItems, unevaluatedProperties, multipleOf, exclusiveMinimum,
 *   exclusiveMaximum, uniqueItems, readOnly, writeOnly, deprecated, $comment.
 *
 * `const` is not simply dropped: it is lowered to a single-value `enum`, which
 * Gemini does understand, so the constraint survives.
 */
const ALLOWED_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "propertyOrdering",
  "anyOf",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minProperties",
  "maxProperties",
  "pattern",
]);

/** Schema fields the API models as proto int64, i.e. serialised as strings. */
const INT64_SCHEMA_KEYS = new Set([
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minProperties",
  "maxProperties",
]);

/**
 * Gemini only accepts a handful of `format` values, keyed by type. Anything
 * else (`uri`, `email`, `uuid`, `hostname`, ...) is rejected outright, so we
 * drop formats we cannot vouch for. `format` is documentary here anyway.
 */
const ALLOWED_FORMATS: Record<string, Set<string>> = {
  STRING: new Set(["enum", "date-time"]),
  INTEGER: new Set(["int32", "int64"]),
  NUMBER: new Set(["float", "double"]),
};

function sanitizeSchema(node: unknown): Record<string, any> {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    // Booleans (`additionalProperties: true`) and junk collapse to "any object".
    return {};
  }
  const src = node as Record<string, any>;
  const out: Record<string, any> = {};

  // JSON Schema allows a union `type`, e.g. ["string", "null"]. Gemini wants a
  // single type plus the `nullable` flag.
  let rawType: unknown = src.type;
  if (Array.isArray(rawType)) {
    const concrete = rawType.filter((t) => t !== "null");
    if (concrete.length !== rawType.length) out.nullable = true;
    rawType = concrete[0];
  }
  if (typeof rawType === "string") out.type = rawType.toUpperCase();

  let rawFormat: unknown;

  for (const [key, value] of Object.entries(src)) {
    if (key === "type" || value === undefined) continue;
    if (!ALLOWED_SCHEMA_KEYS.has(key)) continue;

    switch (key) {
      case "properties": {
        if (value === null || typeof value !== "object") break;
        const props: Record<string, Record<string, any>> = {};
        for (const [propName, propSchema] of Object.entries(
          value as Record<string, unknown>,
        )) {
          props[propName] = sanitizeSchema(propSchema);
        }
        if (Object.keys(props).length > 0) out.properties = props;
        break;
      }
      case "items":
        out.items = sanitizeSchema(value);
        break;
      case "anyOf":
        if (Array.isArray(value) && value.length > 0) {
          out.anyOf = value.map(sanitizeSchema);
        }
        break;
      case "enum":
        // Gemini types `enum` as string[]; coerce numeric/boolean enums.
        if (Array.isArray(value) && value.length > 0) {
          out.enum = value.map((v) => String(v));
        }
        break;
      case "required":
        if (Array.isArray(value) && value.length > 0) {
          out.required = value.filter((v) => typeof v === "string");
        }
        break;
      case "propertyOrdering":
        if (Array.isArray(value) && value.length > 0) out.propertyOrdering = value;
        break;
      case "format":
        rawFormat = value;
        break;
      default:
        out[key] = INT64_SCHEMA_KEYS.has(key) ? String(value) : value;
    }
  }

  // `const: "x"` -> `enum: ["x"]`, preserving the constraint Gemini would
  // otherwise never see.
  if (src.const !== undefined && out.enum === undefined) {
    out.enum = [String(src.const)];
    if (out.type === undefined && typeof src.const === "string") out.type = "STRING";
  }

  if (out.type === undefined && out.properties !== undefined) out.type = "OBJECT";
  if (out.type === undefined && out.items !== undefined) out.type = "ARRAY";
  if (out.type === undefined && out.enum !== undefined && out.anyOf === undefined) {
    out.type = "STRING";
  }

  if (typeof rawFormat === "string") {
    const allowed = ALLOWED_FORMATS[String(out.type)];
    if (allowed?.has(rawFormat)) out.format = rawFormat;
  }

  // An OBJECT with no declared properties and no constraints is rejected by
  // some Gemini validators; `required` referencing absent properties likewise.
  if (out.type === "OBJECT" && out.properties === undefined) {
    delete out.required;
    delete out.propertyOrdering;
  } else if (out.properties && Array.isArray(out.required)) {
    const known = new Set(Object.keys(out.properties));
    out.required = out.required.filter((r: string) => known.has(r));
    if (out.required.length === 0) delete out.required;
  }

  return out;
}

/** Anthropic-shaped tools -> one flat `functionDeclarations` array. */
function toFunctionDeclarations(tools: WireTool[]): FunctionDeclaration[] {
  return tools.map((tool) => {
    const decl: FunctionDeclaration = { name: tool.name };
    if (tool.description) decl.description = tool.description;

    const params = sanitizeSchema(tool.input_schema ?? {});
    // Gemini rejects an OBJECT parameter schema with an empty property map, and
    // the field is optional for zero-argument tools, so omit it entirely.
    if (params.properties && Object.keys(params.properties).length > 0) {
      decl.parameters = params as Schema;
    }
    return decl;
  });
}

// --------------------------------------------------------------------------
// Messages -> contents
// --------------------------------------------------------------------------

/**
 * Gemini 3.x attaches an opaque `thoughtSignature` to the part carrying a
 * function call, and expects it echoed back when that call is replayed as
 * conversation history. `ToolCall` in types.ts has nowhere to carry it, so we
 * stash signatures here keyed by (name, args) and re-attach on the way out.
 * Bounded so a long benchmark run cannot grow it without limit.
 */
const thoughtSignatures = new Map<string, string>();
const MAX_SIGNATURE_CACHE = 512;

function signatureKey(name: string, args: Record<string, any>): string {
  let serialised: string;
  try {
    serialised = JSON.stringify(args ?? {});
  } catch {
    serialised = "";
  }
  return `${name} ${serialised}`;
}

function rememberSignature(key: string, signature: string): void {
  if (thoughtSignatures.size >= MAX_SIGNATURE_CACHE) {
    const oldest = thoughtSignatures.keys().next();
    if (!oldest.done) thoughtSignatures.delete(oldest.value);
  }
  thoughtSignatures.set(key, signature);
}

function toContents(messages: ChatMessage[]): Content[] {
  const contents: Content[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text: msg.content }] });
      continue;
    }

    if (msg.role === "assistant") {
      // Gemini names the assistant role "model".
      const parts: Part[] = [];
      if (msg.text) parts.push({ text: msg.text });
      for (const call of msg.toolCalls ?? []) {
        const part: Part = {
          functionCall: { name: call.name, args: call.args ?? {} },
        };
        const signature = thoughtSignatures.get(
          signatureKey(call.name, call.args ?? {}),
        );
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
      }
      if (parts.length === 0) continue;
      contents.push({ role: "model", parts });
      continue;
    }

    // tool_results: Gemini correlates a functionResponse to its functionCall by
    // NAME, not by an id, so the name is the load-bearing field here.
    const parts: Part[] = (msg.results ?? []).map((result) => ({
      functionResponse: {
        name: result.name,
        response: result.isError
          ? { error: result.content }
          : { output: result.content },
      },
    }));
    if (parts.length === 0) continue;
    contents.push({ role: "user", parts });
  }

  return contents;
}

/** `system` then `systemPreamble`, blank line between. Preamble omitted if empty. */
function buildSystemInstruction(
  system: string,
  systemPreamble: string,
): string | undefined {
  const chunks: string[] = [];
  if (system && system.trim().length > 0) chunks.push(system);
  if (systemPreamble && systemPreamble.trim().length > 0) chunks.push(systemPreamble);
  return chunks.length > 0 ? chunks.join("\n\n") : undefined;
}

// --------------------------------------------------------------------------
// Response normalisation
// --------------------------------------------------------------------------

const REFUSAL_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "LANGUAGE",
]);

function normaliseStopReason(
  res: GenerateContentResponse,
  hasToolCalls: boolean,
): string {
  if (hasToolCalls) return "tool_use";

  // A prompt-level block returns 200 with no candidates; surface it as a
  // refusal rather than throwing.
  const blockReason = res.promptFeedback?.blockReason;
  if (blockReason) return "refusal";
  if (!res.candidates || res.candidates.length === 0) return "refusal";

  const finishReason = res.candidates[0]?.finishReason;
  if (!finishReason) return "end_turn";

  const raw = String(finishReason);
  if (raw === "STOP") return "end_turn";
  if (raw === "MAX_TOKENS") return "max_tokens";
  if (REFUSAL_FINISH_REASONS.has(raw)) return "refusal";
  return raw;
}

function normaliseUsage(res: GenerateContentResponse): Usage {
  const meta = res.usageMetadata;
  // Thinking tokens are billed at the output rate and are not included in
  // candidatesTokenCount, so they belong in outputTokens for costing.
  const output =
    (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0);
  return {
    promptTokens: meta?.promptTokenCount ?? 0,
    outputTokens: output,
    cachedTokens: meta?.cachedContentTokenCount ?? 0,
  };
}

function normaliseResponse(res: GenerateContentResponse): ChatResult {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  const toolCalls: ToolCall[] = [];
  let text = "";

  for (const part of parts) {
    // Thought summaries are not answer text.
    if (part.thought) continue;

    if (typeof part.text === "string") text += part.text;

    if (part.functionCall) {
      const name = part.functionCall.name ?? "";
      const args = (part.functionCall.args ?? {}) as Record<string, any>;
      // The Gemini Developer API does not assign call ids; synthesise a stable
      // one from the tool name plus its ordinal within this turn. The real tool
      // name goes in `name`, which is what the function response correlates on.
      const id = part.functionCall.id ?? `${name}-${toolCalls.length}`;
      toolCalls.push({ id, name, args });

      if (part.thoughtSignature) {
        rememberSignature(signatureKey(name, args), part.thoughtSignature);
      }
    }
  }

  return {
    toolCalls,
    text,
    usage: normaliseUsage(res),
    stopReason: normaliseStopReason(res, toolCalls.length > 0),
  };
}

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

/** Smallest legal prompt, used as the constant baseline when measuring. */
const PROBE_CONTENTS: Content[] = [{ role: "user", parts: [{ text: "x" }] }];

/**
 * Output cap for the two measurement calls. Only `promptTokenCount` is read, so
 * this just needs to be small; it is not squeezed to 1 because Gemini 3 Pro
 * always thinks and a too-tight cap can fail the request outright.
 */
const MEASURE_MAX_TOKENS = 256;

export const geminiProvider: Provider = {
  id: "gemini",
  model: MODEL,
  priceIn: PRICE_IN_PER_MTOK / 1_000_000,
  priceOut: PRICE_OUT_PER_MTOK / 1_000_000,

  async chat(req: ChatRequest): Promise<ChatResult> {
    const declarations = toFunctionDeclarations(req.tools);

    const res = await ai().models.generateContent({
      model: MODEL,
      contents: toContents(req.messages),
      config: {
        maxOutputTokens: req.maxTokens,
        systemInstruction: buildSystemInstruction(req.system, req.systemPreamble),
        ...(declarations.length > 0
          ? { tools: [{ functionDeclarations: declarations }] }
          : {}),
        // The harness drives the tool loop itself; never let the SDK try to
        // invoke anything on our behalf.
        automaticFunctionCalling: { disable: true },
      },
    });

    return normaliseResponse(res);
  },

  /**
   * Prompt tokens attributable to the tool block + preamble.
   *
   * METHOD USED: measurement by difference against two real `generateContent`
   * calls, subtracting the reported `promptTokenCount`.
   *
   * Gemini does expose a dedicated `countTokens` endpoint, but it cannot do this
   * job on the Gemini Developer API: passing either `tools` or
   * `systemInstruction` in `CountTokensConfig` is rejected before the request
   * even leaves the process. Verified against @google/genai v2.13.0, which
   * throws:
   *
   *   "tools parameter is only supported in Gemini Enterprise Agent Platform
   *    mode, not in Gemini Developer API mode."
   *   "systemInstruction parameter is only supported in Gemini Enterprise Agent
   *    Platform mode, not in Gemini Developer API mode."
   *
   * countTokens is therefore still attempted first, so that this adapter picks
   * the cheap path automatically if Google ever lifts that restriction, but the
   * generateContent difference is what actually runs today. Both calls use the
   * same fixed one-word probe prompt, so the probe and any fixed scaffolding
   * cancel out and only the tools + preamble remain. That costs a little money,
   * which is why the harness calls this once per (arm, scenario).
   */
  async measureToolBlock(tools: WireTool[], systemPreamble: string): Promise<number> {
    const declarations = toFunctionDeclarations(tools);
    const withTools =
      declarations.length > 0
        ? { tools: [{ functionDeclarations: declarations }] }
        : {};
    const systemInstruction = buildSystemInstruction("", systemPreamble);

    try {
      const loaded = await ai().models.countTokens({
        model: MODEL,
        contents: PROBE_CONTENTS,
        config: { ...withTools, systemInstruction },
      });
      const bare = await ai().models.countTokens({
        model: MODEL,
        contents: PROBE_CONTENTS,
      });
      const delta = (loaded.totalTokens ?? 0) - (bare.totalTokens ?? 0);
      if (delta > 0) return delta;
    } catch {
      // Expected today; fall through to the generateContent difference.
    }

    const [loaded, bare] = await Promise.all([
      ai().models.generateContent({
        model: MODEL,
        contents: PROBE_CONTENTS,
        config: {
          maxOutputTokens: MEASURE_MAX_TOKENS,
          systemInstruction,
          ...withTools,
          automaticFunctionCalling: { disable: true },
        },
      }),
      ai().models.generateContent({
        model: MODEL,
        contents: PROBE_CONTENTS,
        config: {
          maxOutputTokens: MEASURE_MAX_TOKENS,
          automaticFunctionCalling: { disable: true },
        },
      }),
    ]);

    const delta =
      (loaded.usageMetadata?.promptTokenCount ?? 0) -
      (bare.usageMetadata?.promptTokenCount ?? 0);
    return Math.max(0, delta);
  },
};

export default geminiProvider;
