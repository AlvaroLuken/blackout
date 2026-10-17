// A tiny demo MCP server: a mailer that honours idempotency keys and can answer
// "did op X happen?". Stands in for any real provider with idempotency support.
import { DatabaseSync } from "node:sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export function createMailer(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE IF NOT EXISTS sent (id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT, subject TEXT, body TEXT, idempotency_key TEXT, sent_at TEXT)");
  const server = new Server({ name: "demo-mailer", version: "0.1.0" }, { capabilities: { tools: {} } });
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "send_email", description: "Send one email. Optional idempotency_key: a repeated key returns the original send.", inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, idempotency_key: { type: "string" } }, required: ["to", "subject", "body"] } },
      { name: "get_receipt", description: "Look up a send by idempotency_key. Errors if nothing was sent under that key.", inputSchema: { type: "object", properties: { idempotency_key: { type: "string" } }, required: ["idempotency_key"] } },
      { name: "list_inbox", description: "List emails sent to one address.", inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = (req.params.arguments ?? {}) as Record<string, string>;
    if (req.params.name === "send_email") {
      if (a.idempotency_key) {
        const prior = db.prepare("SELECT * FROM sent WHERE idempotency_key = ?").get(a.idempotency_key);
        if (prior) return text({ status: "already_sent", email: prior });
      }
      const r = db.prepare("INSERT INTO sent (to_addr, subject, body, idempotency_key, sent_at) VALUES (?, ?, ?, ?, ?)").run(a.to, a.subject, a.body, a.idempotency_key ?? null, new Date().toISOString());
      return text({ status: "sent", id: Number(r.lastInsertRowid) });
    }
    if (req.params.name === "get_receipt") {
      const prior = db.prepare("SELECT * FROM sent WHERE idempotency_key = ?").get(a.idempotency_key);
      return prior ? text({ found: true, email: prior }) : { isError: true, content: [{ type: "text" as const, text: "not_found" }] };
    }
    if (req.params.name === "list_inbox") return text(db.prepare("SELECT id, subject, sent_at, idempotency_key FROM sent WHERE to_addr = ? ORDER BY id").all(a.to));
    return { isError: true, content: [{ type: "text" as const, text: `unknown tool ${req.params.name}` }] };
  });
  return { server, db };
}

if (process.argv[1]?.endsWith("demo-mailer.ts")) {
  const { server } = createMailer(process.env.MAILER_DB ?? ":memory:");
  await server.connect(new StdioServerTransport());
}
