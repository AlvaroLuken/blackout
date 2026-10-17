// Live check: a Nemotron agent on Crusoe uses MCP tools through the Blackout gateway.
// Run 1 sends a small backlog. Run 2 is a "restarted" agent given the same job
// with no memory of run 1. Without the gateway it would resend everything.
//   npm run gateway:demo
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { ROOT } from "../config.ts";
import "../llm/crusoe.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bo-gw-demo-"));
const mailerDb = path.join(dir, "mailer.db");
const config = {
  mission: "order-shipped-backlog",
  journal: path.join(dir, "gateway-journal.db"),
  downstream: { command: process.execPath, args: ["--import", "tsx", "--disable-warning=ExperimentalWarning", path.join(ROOT, "src/mcp-gateway/demo-mailer.ts")], env: { MAILER_DB: mailerDb } },
  sideEffects: { send_email: { idempotencyArg: "idempotency_key", receipt: { tool: "get_receipt", arg: "idempotency_key" } } },
};
fs.writeFileSync(path.join(dir, "blackout.mcp.json"), JSON.stringify(config, null, 2));

const MODEL = process.env.BLACKOUT_MODEL ?? "nvidia/Nemotron-3.5-Lightning-30B-A3B";
const FALLBACK = "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B";
const llm = new OpenAI({ apiKey: process.env.CRUSOE_API_KEY, baseURL: process.env.CRUSOE_BASE_URL ?? "https://api.inference.crusoecloud.com/v1", maxRetries: 0, timeout: 90_000 });
const TASK = "Send the 'Your order shipped' email to each of these customers: ana@example.com, ben@example.com, chloe@example.com. Body: 'Your order is on its way.' Then reply DONE.";

async function chat(messages: any[], tools: any[]) {
  let model = MODEL, fails = 0;
  for (let i = 0; i < 8; i++) {
    try {
      return await llm.chat.completions.create({ model, messages, tools, max_tokens: 3000, temperature: 0.2, ...(model !== MODEL ? { chat_template_kwargs: { enable_thinking: false } } : {}) } as any);
    } catch (e: any) {
      if (e?.status === 429 || e?.status >= 500 || /timed out/i.test(String(e?.message))) { if (++fails >= 2 && model === MODEL) { model = FALLBACK; console.log(`   (429 on Lightning, switched to Nemotron 3 Super)`); } await new Promise((r) => setTimeout(r, 1500)); continue; }
      throw e;
    }
  }
  throw new Error("inference unavailable");
}

async function runAgent(label: string) {
  const client = new Client({ name: "nemotron-agent", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "--disable-warning=ExperimentalWarning", path.join(ROOT, "src/mcp-gateway/cli.ts"), "--config", path.join(dir, "blackout.mcp.json")], env: process.env as Record<string, string> }));
  const tools = (await client.listTools()).tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const messages: any[] = [{ role: "user", content: TASK }];
  console.log(`\n${label}`);
  for (let turn = 0; turn < 10; turn++) {
    const res = await chat(messages, tools);
    const m = res.choices[0].message;
    const calls = m.tool_calls ?? [];
    if (!calls.length) { console.log(`   agent: ${(m.content ?? "").trim().slice(0, 80)}`); break; }
    messages.push({ role: "assistant", content: m.content ?? "", tool_calls: calls });
    for (const c of calls) {
      const args = JSON.parse((c as any).function.arguments || "{}");
      const r: any = await client.callTool({ name: (c as any).function.name, arguments: args });
      const text = r.content.map((x: any) => x.text).join(" ");
      const tag = (text.match(/\[blackout\] ([^:]+)/) ?? [])[1] ?? "passed through";
      console.log(`   ${(c as any).function.name}(${args.to ?? ""}) -> ${tag}`);
      messages.push({ role: "tool", tool_call_id: c.id, content: text });
    }
  }
  await client.close();
}

await runAgent("Run 1: Nemotron agent sends the backlog through the Blackout MCP gateway");
await runAgent("Run 2: the agent 'restarts' with no memory and is given the same job");
const db = new DatabaseSync(mailerDb, { readOnly: true });
const rows = db.prepare("SELECT to_addr, COUNT(*) AS n FROM sent GROUP BY to_addr ORDER BY to_addr").all() as { to_addr: string; n: number }[];
console.log("\nMailer inbox counts (from the mailer's own DB):");
for (const r of rows) console.log(`   ${r.to_addr}: ${r.n} ${r.n === 1 ? "✓" : "✗ DUPLICATE"}`);
console.log(`\nfiles: ${dir}`);
