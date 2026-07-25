/**
 * Offline verification of the wire translation + response parsing, using a
 * local HTTP server standing in for generativelanguage.googleapis.com.
 * Proves everything except that Google accepts the payload.
 */
import http from "node:http";

const captured: { url: string; body: any }[] = [];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = req.url ?? "";
    captured.push({ url, body: raw ? JSON.parse(raw) : null });
    res.setHeader("content-type", "application/json");

    if (url.includes(":countTokens")) {
      res.end(JSON.stringify({ totalTokens: raw.includes("functionDeclarations") ? 431 : 12 }));
      return;
    }

    const turn = captured.filter((c) => c.url.includes(":generateContent")).length;
    if (turn === 1) {
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { text: "internal reasoning", thought: true },
                  {
                    functionCall: {
                      name: "get_weather",
                      args: { city: "Paris", unit: "celsius" },
                    },
                    thoughtSignature: "SIG-ABC123",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 512,
            candidatesTokenCount: 21,
            thoughtsTokenCount: 9,
            cachedContentTokenCount: 0,
          },
        }),
      );
    } else {
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "It is 17C with light rain in Paris." }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 601,
            candidatesTokenCount: 14,
            cachedContentTokenCount: 128,
          },
        }),
      );
    }
  });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;
process.env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${port}`;
process.env.GEMINI_API_KEY = "AIzaTEST";

const { geminiProvider } = await import("./bench/providers/gemini.js");
type CM = import("./bench/providers/types.js").ChatMessage;
type WT = import("./bench/providers/types.js").WireTool;

const tools: WT[] = [
  {
    name: "get_weather",
    description: "Get the current weather for a city.",
    input_schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: {
        city: { type: "string", description: "City name", default: "Boston" },
        unit: {
          type: "string",
          enum: ["celsius", "fahrenheit"],
          examples: ["celsius"],
          default: "celsius",
        },
      },
      required: ["city"],
    },
  },
  {
    name: "search_flights",
    description: "Search for flights between two airports.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        origin: { type: "string", format: "uri" },
        destination: { type: "string" },
        passengers: { type: "integer", minimum: 1, maximum: 9, default: 1 },
        stops: {
          type: "array",
          items: { type: "string", $comment: "iata" },
          maxItems: 3,
        },
      },
      required: ["origin", "destination", "ghost"],
    },
  },
  {
    name: "send_email",
    description: "Send an email.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: ["string", "null"] },
        subject: { type: "string" },
        body: { type: "string" },
        priority: { const: "normal" },
      },
      required: ["to", "subject", "body"],
    },
  },
];

const messages: CM[] = [
  { role: "user", content: "What is the weather in Paris right now?" },
];

const r1 = await geminiProvider.chat({
  system: "You are a helpful assistant.",
  systemPreamble: "Always prefer calling a tool over guessing.",
  tools,
  messages,
  maxTokens: 1024,
});

console.log("=== REQUEST 1 (what we send Gemini) ===");
console.log(JSON.stringify(captured[0]!.body, null, 2));
console.log("\n=== PARSED TURN 1 ===");
console.log(JSON.stringify(r1, null, 2));

messages.push({ role: "assistant", toolCalls: r1.toolCalls, text: r1.text });
messages.push({
  role: "tool_results",
  results: r1.toolCalls.map((c) => ({
    id: c.id,
    name: c.name,
    content: JSON.stringify({ temperature_c: 17, conditions: "light rain" }),
  })),
});

const r2 = await geminiProvider.chat({
  system: "You are a helpful assistant.",
  systemPreamble: "Always prefer calling a tool over guessing.",
  tools,
  messages,
  maxTokens: 1024,
});

console.log("\n=== REQUEST 2 contents (multi-turn round trip) ===");
console.log(JSON.stringify(captured[1]!.body.contents, null, 2));
console.log("\n=== PARSED TURN 2 ===");
console.log(JSON.stringify(r2, null, 2));

const measured = await geminiProvider.measureToolBlock(
  tools,
  "Always prefer calling a tool over guessing.",
);
console.log("\n=== measureToolBlock (431 - 12) ===", measured);
console.log("countTokens calls:", captured.filter((c) => c.url.includes(":countTokens")).length);

const checks: [string, boolean][] = [
  ["turn1 stopReason == tool_use", r1.stopReason === "tool_use"],
  ["turn1 one tool call named get_weather", r1.toolCalls.length === 1 && r1.toolCalls[0]!.name === "get_weather"],
  ["turn1 args parsed", r1.toolCalls[0]!.args.city === "Paris" && r1.toolCalls[0]!.args.unit === "celsius"],
  ["turn1 synthesised id", r1.toolCalls[0]!.id === "get_weather-0"],
  ["turn1 thought text excluded", r1.text === ""],
  ["turn1 usage prompt=512 output=30 cached=0", r1.usage.promptTokens === 512 && r1.usage.outputTokens === 30 && r1.usage.cachedTokens === 0],
  ["turn2 stopReason == end_turn", r2.stopReason === "end_turn"],
  ["turn2 cachedTokens=128", r2.usage.cachedTokens === 128],
  ["measureToolBlock == 419", measured === 419],
];
console.log("\n=== ASSERTIONS ===");
let ok = true;
for (const [name, pass] of checks) {
  console.log((pass ? "PASS  " : "FAIL  ") + name);
  if (!pass) ok = false;
}
console.log(ok ? "\nALL OFFLINE CHECKS PASSED" : "\nOFFLINE CHECKS FAILED");
server.close();
