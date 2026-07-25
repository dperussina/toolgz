/** Shared types for the benchmark harness and all compression strategies. */

export type JsonSchema = {
  type: string;
  properties?: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
  [k: string]: any;
};

/** A tool as an MCP server / SDK would hand it to us: full verbose JSON Schema. */
export type ToolDef = {
  name: string;
  description: string;
  input_schema: JsonSchema;
  /** Namespace, used by namespace-collapsing strategies. */
  ns: string;
  /** Operation within the namespace. */
  op: string;
};

/** What a strategy hands to the provider for a given turn. */
export type CompiledRequest = {
  /** Native tool definitions to send on the wire. */
  tools: any[];
  /** Text to prepend to the system prompt (schema dump, manifest, etc). */
  systemPreamble: string;
  /** Whether systemPreamble should sit behind a cache breakpoint. */
  cachePreamble: boolean;
};

/** Result of translating a model tool call back to a real tool invocation. */
export type Resolution =
  | { kind: "call"; name: string; args: Record<string, any> }
  | { kind: "meta"; name: string; result: string }
  | { kind: "error"; message: string };

export interface CompressionStrategy {
  readonly id: string;
  readonly label: string;
  /** Build the request payload for a tool set. */
  compile(tools: ToolDef[]): CompiledRequest;
  /**
   * Translate a raw tool call from the model back into a real tool call,
   * or handle it as a meta-call (search/list/describe) against the catalog.
   */
  resolve(
    tools: ToolDef[],
    rawName: string,
    rawArgs: Record<string, any>,
  ): Resolution;
}

export type TurnRecord = {
  scenario: string;
  arm: string;
  rep: number;
  turn: number;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  total_prompt_tokens: number;
  latency_ms: number;
  stop_reason: string | null;
  calls: { name: string; args: Record<string, any> }[];
  metaCalls: number;
  error?: string;
};

export type ScenarioResult = {
  scenario: string;
  arm: string;
  rep: number;
  toolBlockTokens: number;
  turns: number;
  totalPromptTokens: number;
  totalOutputTokens: number;
  cumulativeOccupancy: number;
  metaCalls: number;
  correctToolCalls: number;
  expectedToolCalls: number;
  hallucinatedNames: number;
  malformedArgs: number;
  taskSuccess: boolean;
  wallMs: number;
  costUsd: number;
  error?: string;
};
