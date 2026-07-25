import "dotenv/config";
import OpenAI from "openai";
const c = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const tools: any[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
];

for (const effort of ["max", "xhigh", "high"]) {
  try {
    const r = await c.responses.create({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
      tools,
      reasoning: { effort: effort as any },
      max_output_tokens: 2000,
    });
    console.log("=== effort", effort, "OK");
    console.log("status:", r.status, "incomplete:", JSON.stringify(r.incomplete_details));
    console.log("usage:", JSON.stringify(r.usage, null, 2));
    console.log("reasoning echo:", JSON.stringify((r as any).reasoning));
    console.log("output:", JSON.stringify(r.output, null, 2));
  } catch (e: any) {
    console.log("=== effort", effort, "FAILED", e?.status, JSON.stringify(e?.error ?? e?.message));
  }
}
