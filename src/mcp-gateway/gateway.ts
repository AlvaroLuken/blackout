// Blackout MCP gateway: sits between any MCP agent and an MCP tool server.
// Tools marked as side effects get exactly-once behaviour:
//   1. A stable op ID is derived from (mission, tool, arguments) and journaled
//      BEFORE the call goes downstream; it is passed as the tool's idempotency key.
//   2. A repeat of the same side effect (a retry, a restarted agent) returns the
//      original result instead of running it again.
//   3. If the gateway itself died mid-call, the next attempt first asks the
//      server's receipt tool what happened. Unknown outcomes are refused, never retried blindly.
// Read-only tools pass straight through. Done-verification (contracts, verifier)
// is not part of the gateway; that stays in the full Blackout runtime.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type SideEffectRule = {
  idempotencyArg?: string;                     // argument the server uses as its idempotency key (optional: without it, the journal alone suppresses repeats)
  receipt?: { tool: string; arg: string };     // "did op X happen?" lookup; not-found = isError
};
export type GatewayConfig = {
  mission: string;
  journal: string;                             // SQLite file, outside the agent's reach
  sideEffects: Record<string, SideEffectRule>;
};

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function opIdFor(mission: string, tool: string, args: Record<string, unknown>, rule: SideEffectRule) {
  const { [rule.idempotencyArg ?? "\u0000"]: _ignored, ...rest } = args;
  return "bo-" + createHash("sha256").update(`${mission}\n${tool}\n${canonical(rest)}`).digest("hex").slice(0, 24);
}

function note(result: CallToolResult, text: string): CallToolResult {
  return { ...result, content: [...(result.content ?? []), { type: "text", text: `[blackout] ${text}` }] };
}

export function openJournal(file: string) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS ops (op_id TEXT PRIMARY KEY, mission TEXT NOT NULL, tool TEXT NOT NULL,
      args TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  return db;
}

export function createGateway(downstream: Client, cfg: GatewayConfig) {
  const db = openJournal(cfg.journal);
  const now = () => new Date().toISOString();
  const get = (op: string) => db.prepare("SELECT * FROM ops WHERE op_id = ?").get(op) as { status: string; result: string | null; updated_at: string } | undefined;
  const set = (op: string, status: string, result: unknown) =>
    db.prepare("UPDATE ops SET status = ?, result = ?, updated_at = ? WHERE op_id = ?").run(status, result == null ? null : JSON.stringify(result), now(), op);

  const server = new Server({ name: "blackout-gateway", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async (req) => downstream.listTools(req.params));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const rule = cfg.sideEffects[name];
    if (!rule) return (await downstream.callTool({ name, arguments: args })) as CallToolResult;

    const op = opIdFor(cfg.mission, name, args, rule);
    const row = get(op);

    if (row?.status === "done") {
      return note(JSON.parse(row.result ?? "{}"), `duplicate suppressed: ${name} already completed as op ${op} at ${row.updated_at}. Not sent again.`);
    }
    if (row?.status === "unknown") {
      return { isError: true, content: [{ type: "text", text: `[blackout] outcome of op ${op} is unknown and cannot be checked. Refusing to repeat it; escalate to a human.` }] };
    }
    if (row?.status === "intent") {
      // A previous attempt was journaled but never acknowledged: the gateway died mid-call.
      if (!rule.receipt) {
        set(op, "unknown", null);
        return { isError: true, content: [{ type: "text", text: `[blackout] op ${op} was interrupted and ${name} has no receipt lookup configured. Refusing to repeat it; escalate to a human.` }] };
      }
      const r = (await downstream.callTool({ name: rule.receipt.tool, arguments: { [rule.receipt.arg]: op } })) as CallToolResult;
      if (!r.isError) {
        set(op, "done", r);
        return note(r, `reconciled: op ${op} was interrupted, and the server's receipt shows it already happened. Not sent again.`);
      }
      // No receipt: it never happened. Safe to retry with the same op ID.
    } else {
      db.prepare("INSERT INTO ops (op_id, mission, tool, args, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'intent', ?, ?)").run(op, cfg.mission, name, JSON.stringify(args), now(), now());
    }

    const sent = rule.idempotencyArg ? { ...args, [rule.idempotencyArg]: op } : args;
    const result = (await downstream.callTool({ name, arguments: sent })) as CallToolResult;
    if (result.isError) { db.prepare("DELETE FROM ops WHERE op_id = ?").run(op); return result; } // nothing happened; allow a clean retry
    set(op, "done", result);
    return note(result, `exactly-once: journaled as op ${op} before sending.`);
  });

  return { server, journal: db };
}
