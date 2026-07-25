import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatRequest,
  ChatResult,
  Provider,
  ToolCall,
  WireTool,
} from "./types.js";

/**
 * Anthropic adapter.
 *
 * The arms already emit Anthropic-shaped tools, so translation is close to a
 * no-op — this exists so Anthropic runs through the same code path as every
 * other provider and the comparison stays honest.
 *
 * Model is the frontier tier. Weak models are explicitly out of scope for the
 * cross-provider comparison.
 */
const MODEL = "claude-opus-5";

const client = new Anthropic();

function systemBlocks(req: ChatRequest) {
  const parts = [req.system];
  if (req.systemPreamble) parts.push(req.systemPreamble);
  return parts.join("\n\n");
}

function toAnthropicMessages(req: ChatRequest): any[] {
  const out: any[] = [];
  for (const m of req.messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      // Echo the original content blocks verbatim when we have them: Opus 5
      // runs adaptive thinking by default and requires thinking blocks
      // returned unchanged. Reconstructing from text + tool calls drops them,
      // which makes the model re-reason from scratch on every turn.
      if (Array.isArray(m.raw)) {
        out.push({ role: "assistant", content: m.raw });
        continue;
      }
      const content: any[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const c of m.toolCalls) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      }
      out.push({ role: "assistant", content });
    } else {
      out.push({
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }
  }
  return out;
}

function normaliseStop(raw: string | null, hasCalls: boolean): string {
  if (hasCalls) return "tool_use";
  switch (raw) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return raw ?? "unknown";
  }
}

export const anthropicProvider: Provider = {
  id: "anthropic",
  model: MODEL,
  // claude-opus-5: $5 / $25 per MTok.
  priceIn: 5.0 / 1_000_000,
  priceOut: 25.0 / 1_000_000,
  // Anthropic cache reads bill at ~0.1x input.
  priceCachedIn: 0.5 / 1_000_000,

  async chat(req: ChatRequest): Promise<ChatResult> {
    const resp: any = await client.messages.create({
      model: MODEL,
      max_tokens: req.maxTokens,
      output_config: { effort: "high" } as any,
      system: systemBlocks(req),
      tools: req.tools as any,
      messages: toAnthropicMessages(req),
    });

    const toolCalls: ToolCall[] = resp.content
      .filter((b: any) => b.type === "tool_use")
      .map((b: any) => ({ id: b.id, name: b.name, args: b.input ?? {} }));

    const text = resp.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");

    const u = resp.usage ?? {};
    const cached = u.cache_read_input_tokens ?? 0;
    return {
      toolCalls,
      text,
      usage: {
        promptTokens:
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          cached,
        outputTokens: u.output_tokens ?? 0,
        cachedTokens: cached,
      },
      stopReason: normaliseStop(resp.stop_reason, toolCalls.length > 0),
      raw: resp.content,
    };
  },

  async measureToolBlock(tools: WireTool[], systemPreamble: string) {
    // Anthropic has a real token-counting endpoint — no inference cost.
    const sys = systemPreamble ? `S\n\n${systemPreamble}` : "S";
    const withTools = await client.messages.countTokens({
      model: MODEL,
      tools: tools as any,
      system: sys,
      messages: [{ role: "user", content: "x" }],
    });
    const bare = await client.messages.countTokens({
      model: MODEL,
      system: "S",
      messages: [{ role: "user", content: "x" }],
    });
    return withTools.input_tokens - bare.input_tokens;
  },
};
