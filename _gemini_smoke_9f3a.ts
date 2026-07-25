import "dotenv/config";
import { geminiProvider } from "./bench/providers/gemini.js";
import type { ChatMessage, WireTool } from "./bench/providers/types.js";

const tools: WireTool[] = [
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
        stops: { type: "array", items: { type: "string", $comment: "iata" }, maxItems: 3 },
      },
      required: ["origin", "destination"],
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

async function main() {
  console.log("model:", geminiProvider.model);
  console.log("priceIn:", geminiProvider.priceIn, "priceOut:", geminiProvider.priceOut);

  // ---- turn 1: force a tool call -----------------------------------------
  const messages: ChatMessage[] = [
    { role: "user", content: "What is the weather in Paris right now? Use the tools." },
  ];

  const r1 = await geminiProvider.chat({
    system: "You are a helpful assistant.",
    systemPreamble: "Always prefer calling a tool over guessing.",
    tools,
    messages,
    maxTokens: 1024,
  });

  console.log("\n--- TURN 1 ---");
  console.log("stopReason:", r1.stopReason);
  console.log("toolCalls:", JSON.stringify(r1.toolCalls, null, 2));
  console.log("text:", JSON.stringify(r1.text));
  console.log("usage:", JSON.stringify(r1.usage));

  if (r1.toolCalls.length === 0) throw new Error("FAIL: no tool call returned on turn 1");
  if (r1.stopReason !== "tool_use") throw new Error(`FAIL: stopReason ${r1.stopReason}`);
  if (r1.usage.promptTokens <= 0 || r1.usage.outputTokens <= 0) {
    throw new Error("FAIL: zero usage");
  }

  const call = r1.toolCalls[0]!;
  if (call.name !== "get_weather") throw new Error(`FAIL: wrong tool ${call.name}`);
  if (typeof call.args.city !== "string") throw new Error("FAIL: args.city not parsed");

  // ---- turn 2: feed the function response back ---------------------------
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

  console.log("\n--- TURN 2 ---");
  console.log("stopReason:", r2.stopReason);
  console.log("text:", JSON.stringify(r2.text));
  console.log("usage:", JSON.stringify(r2.usage));

  if (!r2.text.toLowerCase().includes("17") && !r2.text.toLowerCase().includes("rain")) {
    throw new Error("FAIL: turn 2 did not use the function response");
  }
  if (r2.usage.promptTokens <= r1.usage.promptTokens) {
    throw new Error("FAIL: turn 2 prompt did not grow");
  }

  // ---- measureToolBlock ---------------------------------------------------
  const measured = await geminiProvider.measureToolBlock(
    tools,
    "Always prefer calling a tool over guessing.",
  );
  console.log("\n--- measureToolBlock ---");
  console.log("tokens:", measured);
  if (measured <= 0) throw new Error("FAIL: measureToolBlock returned 0");

  console.log("\nSMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED");
  console.error(err?.message ?? err);
  process.exit(1);
});
