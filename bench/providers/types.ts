/**
 * Provider abstraction for the benchmark harness.
 *
 * The arms in bench/strategies emit Anthropic-shaped tool definitions
 * (`{name, description, input_schema}`) plus an optional system preamble.
 * Each provider adapter is responsible for translating that into its own
 * wire format and normalising the response back into `ChatResult`.
 *
 * Adapters live in bench/, never in src/. They may make network calls.
 */

/** Anthropic-shaped tool definition, as emitted by every arm. */
export type WireTool = {
  name: string;
  description?: string;
  input_schema: Record<string, any>;
  [k: string]: any;
};

export type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      toolCalls: ToolCall[];
      text?: string;
      /**
       * Opaque provider-native turn payload, round-tripped verbatim.
       *
       * Exists because some providers carry reasoning state that must be
       * echoed back unmodified on the next turn (Anthropic requires thinking
       * blocks returned unchanged on the same model; reconstructing the turn
       * from text + tool calls alone silently drops them and makes the model
       * re-reason every turn). Adapters that have no such state ignore it.
       */
      raw?: unknown;
    }
  | { role: "tool_results"; results: ToolResult[] };

export type ToolCall = {
  /** Provider-assigned call id, echoed back with the result. */
  id: string;
  name: string;
  args: Record<string, any>;
};

export type ToolResult = {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
};

export type Usage = {
  /** Total prompt tokens actually processed, including any cached portion. */
  promptTokens: number;
  outputTokens: number;
  /** Portion of promptTokens served from cache. 0 if unknown/unsupported. */
  cachedTokens: number;
};

export type ChatResult = {
  toolCalls: ToolCall[];
  text: string;
  usage: Usage;
  /** Normalised: "tool_use" | "end_turn" | "max_tokens" | "refusal" | other. */
  stopReason: string;
  /** Provider-native turn payload; the runner feeds this back as `raw`. */
  raw?: unknown;
};

export type ChatRequest = {
  system: string;
  /** Extra system text from the arm (e.g. the level-3 <toolmap>). May be "". */
  systemPreamble: string;
  tools: WireTool[];
  messages: ChatMessage[];
  maxTokens: number;
};

export interface Provider {
  /** Stable id used in filenames and result rows, e.g. "openai". */
  readonly id: string;
  /** Exact model id sent on the wire. */
  readonly model: string;
  /** $ per input / output token (not per million). */
  readonly priceIn: number;
  readonly priceOut: number;
  /**
   * $ per cached input token, when the provider discounts them.
   *
   * Without this, cached tokens bill at full input price and providers that
   * cache aggressively look more expensive than they are — a real distortion,
   * since cached reads are typically ~10% of input price. Omit when the
   * provider does not discount, or when the rate is unknown; the runner then
   * falls back to `priceIn` and the figure is an upper bound.
   */
  readonly priceCachedIn?: number;

  /** One turn. Must not throw on refusal — set stopReason instead. */
  chat(req: ChatRequest): Promise<ChatResult>;

  /**
   * Prompt tokens attributable to the tool block + preamble alone.
   *
   * Providers without a token-counting endpoint should measure by difference:
   * issue a minimal request with tools and one without, and subtract the
   * reported prompt tokens. That costs a little money and is why it is called
   * once per (arm, scenario), never per run.
   */
  measureToolBlock(tools: WireTool[], systemPreamble: string): Promise<number>;
}
