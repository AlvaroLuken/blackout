// Crusoe smoke test: list the catalog, then make one tiny native tool call.
// Prints model capabilities and usage. Never prints the key.
import "./crusoe.ts";
import OpenAI from "openai";
import { MODEL, hasKey, estimateUsd } from "./crusoe.ts";

if (!hasKey()) {
  console.error("BLOCKED: CRUSOE_API_KEY is not set. Put it in .env (see .env.example).");
  process.exit(2);
}
const baseURL = process.env.CRUSOE_BASE_URL ?? "https://api.inference.crusoecloud.com/v1";
const c = new OpenAI({ apiKey: process.env.CRUSOE_API_KEY, baseURL });

const r = await fetch(`${baseURL}/models`, { headers: { authorization: `Bearer ${process.env.CRUSOE_API_KEY}` } });
console.log("GET /v1/models ->", r.status);
const cat = (await r.json()) as any;
const models = (cat.data ?? []) as any[];
for (const m of models.filter((m) => /nemotron|gpt-oss/i.test(m.id))) {
  console.log(` ${m.id}  ctx=${m.context_length ?? "?"}  max_out=${m.top_provider?.max_completion_tokens ?? "?"}  params=${(m.supported_parameters ?? []).join(",") || "?"}  pricing=${JSON.stringify(m.pricing ?? null)}`);
}
if (!models.some((m) => m.id === MODEL)) console.log(`WARNING: ${MODEL} not in catalog`);

const t0 = Date.now();
const res = await c.chat.completions.create({
  model: MODEL,
  max_tokens: 2048,
  messages: [{ role: "user", content: "Call the add tool to compute 17 + 25. Use the tool; do not answer directly." }],
  tools: [{ type: "function", function: { name: "add", description: "Add two integers", parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] } } }],
  tool_choice: "auto",
});
const m = res.choices[0].message as any;
console.log("model:", res.model, "finish:", res.choices[0].finish_reason, "latency_ms:", Date.now() - t0);
console.log("tool_calls:", JSON.stringify(m.tool_calls ?? null));
console.log("content:", JSON.stringify((m.content ?? "").slice(0, 200)));
console.log("reasoning present:", !!(m.reasoning_content ?? m.reasoning));
console.log("usage:", JSON.stringify(res.usage), "est_usd:", res.usage ? estimateUsd(MODEL, res.usage.prompt_tokens, res.usage.completion_tokens) : "unknown");
