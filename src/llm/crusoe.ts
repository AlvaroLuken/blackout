// Crusoe Managed Inference client (OpenAI-compatible). Every call is
// budget-checked against the journal before it is sent, and its usage is
// recorded after. Keys come from the environment and are never logged.
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { ROOT } from "../config.ts";
import type { Journal } from "../store/journal.ts";

// Load .env without a dependency. Only KEY=VALUE lines; existing env wins.
export function loadEnv() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
loadEnv();

// USD per 1M tokens, from the official hackathon model reference (Oct 2026).
// Recheck against the live catalog; unknown models are recorded as cost unknown.
export const PRICING: Record<string, { in: number; out: number; cached?: number }> = {
  "nvidia/Nemotron-3.5-Lightning-30B-A3B": { in: 0.05, out: 0.2, cached: 0.03 }, // confirmed in live catalog by the crusoe session, Oct 17
  "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B": { in: 0.3, out: 2.4 },
  "nvidia/Nemotron-3-Nano-30B-A3B": { in: 0.05, out: 0.2 },
  "openai/gpt-oss-120b": { in: 0.05, out: 0.2 },
};

export const MODEL = process.env.BLACKOUT_MODEL ?? "nvidia/Nemotron-3.5-Lightning-30B-A3B";

export type Limits = { maxUsd: number; maxCalls: number; maxTokens: number; deadline: number };
export function limitsFromEnv(deadlineMs = 15 * 60_000): Limits {
  return {
    maxUsd: Number(process.env.BLACKOUT_MAX_USD ?? 1),
    maxCalls: Number(process.env.BLACKOUT_MAX_CALLS ?? 80),
    maxTokens: Number(process.env.BLACKOUT_MAX_TOKENS ?? 600_000),
    deadline: Date.now() + deadlineMs,
  };
}

export class BudgetExceeded extends Error {}
export class InferenceUnavailable extends Error {}

export function hasKey() {
  return !!process.env.CRUSOE_API_KEY && process.env.CRUSOE_API_KEY !== "replace-me";
}

let client: OpenAI | null = null;
function getClient() {
  if (!hasKey()) throw new InferenceUnavailable("CRUSOE_API_KEY is not set; live inference is blocked");
  client ??= new OpenAI({
    apiKey: process.env.CRUSOE_API_KEY,
    baseURL: process.env.CRUSOE_BASE_URL ?? "https://api.inference.crusoecloud.com/v1",
    timeout: 90_000,
    maxRetries: 0,
  });
  return client;
}

// Cost from the API's own usage counts times catalog list prices.
export function estimateUsd(model: string, pin: number, pout: number, cached = 0): number | null {
  const p = PRICING[model];
  if (!p) return null;
  const c = Math.min(cached, pin);
  return ((pin - c) * p.in + c * (p.cached ?? p.in) + pout * p.out) / 1e6;
}

export type ChatArgs = {
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  max_tokens?: number;
  json?: boolean;
  thinking?: boolean; // false sends chat_template_kwargs.enable_thinking=false
};

export async function chat(journal: Journal, missionId: string, actor: string, limits: Limits, args: ChatArgs) {
  const t = journal.usageTotals(missionId);
  if (t.calls >= limits.maxCalls) throw new BudgetExceeded(`call limit ${limits.maxCalls} reached`);
  if ((t.est_usd ?? 0) >= limits.maxUsd) throw new BudgetExceeded(`spend limit $${limits.maxUsd} reached`);
  if (t.prompt_tokens + t.completion_tokens >= limits.maxTokens) throw new BudgetExceeded(`token limit ${limits.maxTokens} reached`);
  if (Date.now() > limits.deadline) throw new BudgetExceeded("mission time limit reached");

  const c = getClient();
  let lastErr: unknown;
  const maxAttempts = Number(process.env.BLACKOUT_RETRIES ?? 5);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Shared pacing: coordinator and worker processes draw from one per-minute budget.
    const rpm = Number(process.env.BLACKOUT_RPM ?? 40);
    for (let w = journal.reserveRequestSlot(rpm); w > 0; w = journal.reserveRequestSlot(rpm)) {
      if (Date.now() + w > limits.deadline) throw new BudgetExceeded("mission time limit reached while rate limited");
      journal.event(missionId, actor, "rate_paced", { wait_ms: w });
      await new Promise((r) => setTimeout(r, w));
    }
    const started = Date.now();
    try {
      const res = await c.chat.completions.create({
        model: MODEL,
        messages: args.messages,
        tools: args.tools,
        tool_choice: args.tools ? "auto" : undefined,
        max_tokens: args.max_tokens ?? 4096,
        temperature: 0.2,
        ...(args.json ? { response_format: { type: "json_object" as const } } : {}),
        ...(args.thinking === false ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      } as any);
      const u = res.usage;
      const choice = res.choices[0];
      journal.recordUsage(missionId, {
        actor,
        model: res.model ?? MODEL,
        prompt_tokens: u?.prompt_tokens ?? 0,
        completion_tokens: u?.completion_tokens ?? 0,
        cached_tokens: (u as any)?.prompt_tokens_details?.cached_tokens ?? 0,
        est_usd: u ? estimateUsd(MODEL, u.prompt_tokens, u.completion_tokens, (u as any)?.prompt_tokens_details?.cached_tokens ?? 0) : null,
        latency_ms: Date.now() - started,
        finish_reason: choice?.finish_reason ?? "none",
      });
      return { message: choice.message, finish_reason: choice.finish_reason };
    } catch (e: any) {
      lastErr = e;
      const status = e?.status;
      if (status === 429 || status === 503 || status === 502 || e?.name === "APIConnectionTimeoutError") {
        journal.event(missionId, actor, "inference_retry", { status: status ?? e?.name, attempt });
        await new Promise((r) => setTimeout(r, Math.min(20_000, 2000 * 2 ** attempt) + Math.random() * 1500));
        continue;
      }
      throw new InferenceUnavailable(`inference failed: ${status ?? ""} ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  throw new InferenceUnavailable(`inference failed after retries: ${String((lastErr as any)?.message ?? lastErr).slice(0, 200)}`);
}

// Pull a JSON object out of model text (fenced or bare). Used for structured
// outputs and as the documented fallback when native tool calls are missing.
export function extractJson(text: string | null | undefined): any | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cand = fenced ? fenced[1] : text;
  const start = cand.indexOf("{");
  const end = cand.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cand.slice(start, end + 1)); } catch { return null; }
}
