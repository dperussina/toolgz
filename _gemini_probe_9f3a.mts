import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const pager = await ai.models.list();
const rows: any[] = [];
for await (const m of pager) rows.push(m);
console.log("GEMINI_MODEL_COUNT", rows.length);
for (const m of rows) {
  console.log("GM|" + JSON.stringify({ name: m.name, display: (m as any).displayName, in: (m as any).inputTokenLimit, out: (m as any).outputTokenLimit, actions: (m as any).supportedActions }));
}
