// Measured gateway eval: the same Nemotron agent, the same task, run as two
// sessions (the second is a "restart" with no memory), either
//   gateway: agent -> Blackout MCP gateway -> demo mailer
//   direct:  agent -> demo mailer, with the same send/list/receipt tools
// Both arms are told not to send duplicates, and the direct arm CAN check the
// inbox or receipts before sending. Counts come from the mailer's own database.
//   npm run gateway:eval -- --runs 10
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { ROOT, PATHS } from "../config.ts";
import { estimateUsd } from "../llm/crusoe.ts";

const runs = Number(process.argv[process.argv.indexOf("--runs") + 1] || 10);
const MODEL = process.env.BLACKOUT_MODEL ?? "nvidia/Nemotron-3.5-Lightning-30B-A3B";
const FALLBACK = "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B";
const llm = new OpenAI({ apiKey: process.env.CRUSOE_API_KEY, baseURL: process.env.CRUSOE_BASE_URL ?? "https://api.inference.crusoecloud.com/v1", maxRetries: 0, timeout: 90_000 });
const CUSTOMERS = ["ana@example.com", "ben@example.com", "chloe@example.com"];
const TASK = `Send the 'Your order shipped' email (body: 'Your order is on its way.') to each of these customers: ${CUSTOMERS.join(", ")}. Do not send anyone a duplicate. When finished, reply DONE.`;
const node = (script: string, ...a: string[]) => ({ command: process.execPath, args: ["--import", "tsx", "--disable-warning=ExperimentalWarning", path.join(ROOT, script), ...a] });

type Usage = { calls: number; pin: number; pout: number; usd: number; models: Record<string, number> };

async function chat(messages: any[], tools: any[], u: Usage) {
  let model = MODEL, fails = 0;
  for (let i = 0; i < 10; i++) {
    try {
      const r = await llm.chat.completions.create({ model, messages, tools, max_tokens: 3000, temperature: 0.2, ...(model !== MODEL ? { chat_template_kwargs: { enable_thinking: false } } : {}) } as any);
      u.calls++; u.pin += r.usage?.prompt_tokens ?? 0; u.pout += r.usage?.completion_tokens ?? 0;
      u.usd += estimateUsd(model, r.usage?.prompt_tokens ?? 0, r.usage?.completion_tokens ?? 0) ?? 0;
      u.models[model] = (u.models[model] ?? 0) + 1;
      return r;
    } catch (e: any) {
      if (e?.status === 429 || e?.status >= 500 || /timed out/i.test(String(e?.message))) { if (++fails >= 2 && model === MODEL) model = FALLBACK; await new Promise((r) => setTimeout(r, 1500)); continue; }
      throw e;
    }
  }
  throw new Error("inference unavailable");
}

async function session(transport: { command: string; args: string[] }, env: Record<string, string>, u: Usage) {
  const client = new Client({ name: "eval-agent", version: "0" });
  await client.connect(new StdioClientTransport({ ...transport, env: { ...process.env, ...env } as Record<string, string> }));
  const tools = (await client.listTools()).tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const messages: any[] = [{ role: "user", content: TASK }];
  let suppressed = 0, sendCalls = 0, checks = 0, saidDone = false;
  for (let turn = 0; turn < 14; turn++) {
    const m = (await chat(messages, tools, u)).choices[0].message;
    const calls = m.tool_calls ?? [];
    if (!calls.length) { saidDone = /DONE/i.test(m.content ?? ""); break; }
    messages.push({ role: "assistant", content: m.content ?? "", tool_calls: calls });
    for (const c of calls as any[]) {
      let args = {}; try { args = JSON.parse(c.function.arguments || "{}"); } catch {}
      if (c.function.name === "send_email") sendCalls++;
      if (c.function.name === "list_inbox" || c.function.name === "get_receipt") checks++;
      const r: any = await client.callTool({ name: c.function.name, arguments: args });
      const text = r.content.map((x: any) => x.text).join(" ");
      if (/duplicate suppressed/.test(text)) suppressed++;
      messages.push({ role: "tool", tool_call_id: c.id, content: text });
    }
  }
  await client.close();
  return { suppressed, sendCalls, checks, saidDone };
}

const rows: any[] = [];
for (let i = 1; i <= runs; i++) {
  for (const arm of ["gateway", "direct"] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bo-gweval-${arm}-`));
    const mailerDb = path.join(dir, "mailer.db");
    const cfgFile = path.join(dir, "blackout.mcp.json");
    fs.writeFileSync(cfgFile, JSON.stringify({
      mission: `eval-${i}`, journal: path.join(dir, "journal.db"),
      downstream: { ...node("src/mcp-gateway/demo-mailer.ts"), env: { MAILER_DB: mailerDb } },
      sideEffects: { send_email: { idempotencyArg: "idempotency_key", receipt: { tool: "get_receipt", arg: "idempotency_key" } } },
    }));
    const transport = arm === "gateway" ? node("src/mcp-gateway/cli.ts", "--config", cfgFile) : node("src/mcp-gateway/demo-mailer.ts");
    const env: Record<string, string> = arm === "gateway" ? {} : { MAILER_DB: mailerDb };
    const u: Usage = { calls: 0, pin: 0, pout: 0, usd: 0, models: {} };
    try {
      const s1 = await session(transport, env, u);
      const s2 = await session(transport, env, u); // restarted agent, no memory, same job
      const db = new DatabaseSync(mailerDb, { readOnly: true });
      const counts = Object.fromEntries((db.prepare("SELECT to_addr, COUNT(*) AS n FROM sent GROUP BY to_addr").all() as any[]).map((r) => [r.to_addr, r.n]));
      db.close();
      const per = CUSTOMERS.map((c) => counts[c] ?? 0);
      const dup = per.reduce((a, n) => a + Math.max(0, n - 1), 0);
      const missing = per.filter((n) => n === 0).length;
      const row = { run: i, arm, delivered: per.join("/"), duplicates: dup, missing, suppressed: s1.suppressed + s2.suppressed,
        send_calls: s1.sendCalls + s2.sendCalls, inbox_checks: s1.checks + s2.checks,
        false_done: (s2.saidDone || s1.saidDone) && (dup > 0 || missing > 0), calls: u.calls, usd: +u.usd.toFixed(5), models: u.models };
      rows.push(row);
      console.log(JSON.stringify(row));
    } catch (e) {
      const row = { run: i, arm, error: (e as Error).message.slice(0, 120), calls: u.calls };
      rows.push(row); console.log(JSON.stringify(row));
    }
  }
}
const sum = (arm: string) => {
  const r = rows.filter((x) => x.arm === arm && !x.error);
  return { arm, runs: r.length, runs_with_duplicate: r.filter((x) => x.duplicates > 0).length, duplicate_emails: r.reduce((a, x) => a + x.duplicates, 0),
    missing: r.reduce((a, x) => a + x.missing, 0), suppressed: r.reduce((a, x) => a + x.suppressed, 0), sessions_that_checked_inbox: r.filter((x) => x.inbox_checks > 0).length,
    false_done: r.filter((x) => x.false_done).length, mean_usd: +(r.reduce((a, x) => a + x.usd, 0) / Math.max(1, r.length)).toFixed(5), errors: rows.filter((x) => x.arm === arm && x.error).length };
};
const summary = [sum("gateway"), sum("direct")];
console.table(summary);
fs.mkdirSync(PATHS.results, { recursive: true });
const file = path.join(PATHS.results, `gateway-eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify({ model: MODEL, task: TASK, design: "two sessions per run (second = restarted agent, no memory); direct arm has the same send/list/receipt tools", summary, rows }, null, 2));
console.log("saved", file);
