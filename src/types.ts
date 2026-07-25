/** Public types. Everything a consumer touches is declared here. */

export type JsonSchema = {
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
  items?: any;
  enum?: any[];
  [k: string]: any;
};

/**
 * A tool as you already have it — the same shape MCP servers and every major
 * SDK produce. `inputSchema` and `input_schema` are both accepted.
 */
export type Tool = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  input_schema?: JsonSchema;
};

/** Normalized internal form. */
export type NormalizedTool = {
  name: string;
  description: string;
  schema: JsonSchema;
  ns: string;
  op: string;
};

/**
 * Compression levels. Each is a superset of the previous.
 *
 *  0  passthrough        — no change; useful as an A/B control in your own app
 *  1  signature          — flatten JSON Schema, keep native tools + real names
 *  2  namespace          — collapse related ops into one tool per namespace
 *  3  minified           — single dispatcher + opaque codes
 */
export type Level = 0 | 1 | 2 | 3;

export type CompressOptions = {
  level?: Level;
  /**
   * Group tools into namespaces. Default splits on the first `_` or `.`,
   * which matches MCP naming convention (`github_create_issue`).
   */
  namespaceOf?: (toolName: string) => { ns: string; op: string };
  /** Override the short alias used for a namespace at level 2. */
  aliasOf?: (ns: string) => string;
  /** Cap how many results a search/query meta-call returns. Default 8. */
  searchLimit?: number;
  /** Validate arguments against the original schema before dispatch. Default true. */
  validate?: boolean;
};

export type Resolution =
  | { kind: "call"; name: string; args: Record<string, any> }
  | { kind: "meta"; name: string; result: string }
  | { kind: "error"; message: string; recoverable: boolean };

export type CompressStats = {
  level: Level;
  toolCount: number;
  wireToolCount: number;
  originalChars: number;
  compressedChars: number;
  savedPct: number;
};

export type CompressResult = {
  /** Tool definitions to send on the wire, in Anthropic shape. */
  tools: unknown[];
  /** Text to append to your system prompt. Empty string at levels 0–1. */
  systemPreamble: string;
  /** Whether the preamble should sit behind a cache breakpoint. */
  cachePreamble: boolean;
  /** Translate a raw model tool call back to a real one. */
  resolve(rawName: string, rawArgs: Record<string, any>): Resolution;
  /** Map a real tool name to its level-3 code. Throws below level 3. */
  codeFor(toolName: string): string;
  /** Build the raw call a model would emit for a real tool. Test/debug aid. */
  encodeCallForTest(
    toolName: string,
    args: Record<string, any>,
  ): { name: string; args: Record<string, any> };
  stats: CompressStats;
};
