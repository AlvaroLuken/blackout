import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGateway, opIdFor, type GatewayConfig } from "../src/mcp-gateway/gateway.ts";
import { createMailer } from "../src/mcp-gateway/demo-mailer.ts";

const EMAIL = { to: "ana@example.com", subject: "Your order shipped", body: "Order 4417 is on its way." };
const RULES: GatewayConfig["sideEffects"] = { send_email: { idempotencyArg: "idempotency_key", receipt: { tool: "get_receipt", arg: "idempotency_key" } } };

async function setup(journal: string, mailerDb = ":memory:", rules = RULES) {
  const mailer = createMailer(mailerDb);
  const [mA, mB] = InMemoryTransport.createLinkedPair();
  await mailer.server.connect(mA);
  const downstream = new Client({ name: "gw", version: "0" });
  await downstream.connect(mB);
  const gw = createGateway(downstream, { mission: "backlog-1", journal, sideEffects: rules });
  const [gA, gB] = InMemoryTransport.createLinkedPair();
  await gw.server.connect(gA);
  const agent = new Client({ name: "agent", version: "0" });
  await agent.connect(gB);
  const inbox = () => (mailer.db.prepare("SELECT COUNT(*) AS n FROM sent WHERE to_addr = ?").get(EMAIL.to) as { n: number }).n;
  return { agent, downstream, mailer, gw, inbox };
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bo-gw-")), "journal.db");
const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");

test("without the gateway, an agent that repeats a send emails the customer twice", async () => {
  const { downstream, inbox } = await setup(tmp());
  await downstream.callTool({ name: "send_email", arguments: EMAIL });
  await downstream.callTool({ name: "send_email", arguments: EMAIL });
  assert.equal(inbox(), 2);
});

test("through the gateway, a repeated send (retry or restarted agent) is suppressed", async () => {
  const { agent, inbox } = await setup(tmp());
  const first = await agent.callTool({ name: "send_email", arguments: EMAIL });
  const again = await agent.callTool({ name: "send_email", arguments: EMAIL });
  assert.equal(inbox(), 1);
  assert.match(textOf(first), /exactly-once/);
  assert.match(textOf(again), /duplicate suppressed/);
});

test("the journal outlives the agent: a brand-new agent session cannot resend", async () => {
  const journal = tmp();
  const mailerDb = path.join(path.dirname(journal), "mailer.db");
  const a = await setup(journal, mailerDb);
  await a.agent.callTool({ name: "send_email", arguments: EMAIL });
  const b = await setup(journal, mailerDb); // new agent, new gateway process, same journal and mailer
  const r = await b.agent.callTool({ name: "send_email", arguments: EMAIL });
  assert.equal(b.inbox(), 1);
  assert.match(textOf(r), /duplicate suppressed/);
});

test("gateway died mid-call after the send: reconciles from the receipt instead of resending", async () => {
  const journal = tmp();
  const { agent, mailer, gw, inbox } = await setup(journal);
  const op = opIdFor("backlog-1", "send_email", EMAIL, RULES.send_email);
  // Simulate: intent journaled, the mailer sent it, the gateway crashed before recording success.
  gw.journal.prepare("INSERT INTO ops (op_id, mission, tool, args, status, created_at, updated_at) VALUES (?, 'backlog-1', 'send_email', '{}', 'intent', 'x', 'x')").run(op);
  mailer.db.prepare("INSERT INTO sent (to_addr, subject, body, idempotency_key, sent_at) VALUES (?, ?, ?, ?, 'x')").run(EMAIL.to, EMAIL.subject, EMAIL.body, op);
  const r = await agent.callTool({ name: "send_email", arguments: EMAIL });
  assert.equal(inbox(), 1);
  assert.match(textOf(r), /reconciled/);
});

test("gateway died mid-call before the send: no receipt, so it retries once with the same op ID", async () => {
  const journal = tmp();
  const { agent, gw, inbox } = await setup(journal);
  const op = opIdFor("backlog-1", "send_email", EMAIL, RULES.send_email);
  gw.journal.prepare("INSERT INTO ops (op_id, mission, tool, args, status, created_at, updated_at) VALUES (?, 'backlog-1', 'send_email', '{}', 'intent', 'x', 'x')").run(op);
  await agent.callTool({ name: "send_email", arguments: EMAIL });
  assert.equal(inbox(), 1);
});

test("interrupted op with no receipt lookup: refuses and escalates instead of guessing", async () => {
  const journal = tmp();
  const rules = { send_email: { idempotencyArg: "idempotency_key" } };
  const { agent, gw, inbox } = await setup(journal, ":memory:", rules);
  const op = opIdFor("backlog-1", "send_email", EMAIL, rules.send_email);
  gw.journal.prepare("INSERT INTO ops (op_id, mission, tool, args, status, created_at, updated_at) VALUES (?, 'backlog-1', 'send_email', '{}', 'intent', 'x', 'x')").run(op);
  const r = await agent.callTool({ name: "send_email", arguments: EMAIL });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /escalate/);
  assert.equal(inbox(), 0);
});

test("read-only tools pass straight through, and different emails are not merged", async () => {
  const { agent, inbox } = await setup(tmp());
  await agent.callTool({ name: "send_email", arguments: EMAIL });
  await agent.callTool({ name: "send_email", arguments: { ...EMAIL, subject: "Your order was delivered" } });
  const list = await agent.callTool({ name: "list_inbox", arguments: { to: EMAIL.to } });
  assert.equal(inbox(), 2);
  assert.doesNotMatch(textOf(list), /blackout/);
});

test("tools with strict schemas: no idempotency arg configured, the journal alone still suppresses repeats", async () => {
  const rules = { send_email: {} };
  const { agent, inbox, mailer } = await setup(tmp(), ":memory:", rules as any);
  await agent.callTool({ name: "send_email", arguments: EMAIL });
  const again = await agent.callTool({ name: "send_email", arguments: EMAIL });
  assert.equal(inbox(), 1);
  assert.match(textOf(again), /duplicate suppressed/);
  const keys = mailer.db.prepare("SELECT idempotency_key FROM sent").all() as { idempotency_key: string | null }[];
  assert.equal(keys[0].idempotency_key, null); // nothing extra was sent to the tool
});
