// Done-checks for the gateway (promise #2: "done" is decided by code).
// blackout_define_done: checks come from a fixed vocabulary, drafted by Nemotron on
// Crusoe (or supplied by the caller), validated and frozen by hash. They cannot change.
// blackout_check_done: plain code evaluates the frozen checks against the journal and,
// where configured, the server's own receipts. A model may draft an escalation summary
// on FAIL; it never decides the verdict.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GatewayConfig } from "./gateway.ts";

export const DoneCheck = z.discriminatedUnion("kind", [
  // Every listed value of `arg` has exactly one completed call of `tool`.
  z.object({ kind: z.literal("exactly_once_per"), tool: z.string().min(1), arg: z.string().min(1), values: z.array(z.string().min(1)).min(1).max(200) }),
  // At least `count` completed calls of `tool`.
  z.object({ kind: z.literal("min_completed"), tool: z.string().min(1), count: z.number().int().min(1).max(10000) }),
  // No side effect is left with an unknown or unfinished outcome.
  z.object({ kind: z.literal("no_unknown_outcomes") }),
]);
export type DoneCheck = z.infer<typeof DoneCheck>;
const Checks = z.array(DoneCheck).min(1).max(20);

export const DONE_TOOLS = [
  {
    name: "blackout_define_done",
    description: "Freeze the definition of done for this mission before doing the work. Pass `goal` in plain words; Blackout drafts checks with Nemotron on Crusoe (if CRUSOE_API_KEY is set), or pass `checks` yourself. Once frozen it cannot be changed.",
    inputSchema: { type: "object", properties: { goal: { type: "string" }, checks: { type: "array", items: { type: "object" } } }, required: ["goal"] },
  },
  {
    name: "blackout_check_done",
    description: "Ask Blackout whether the mission is done. Plain code checks the frozen definition against the journal and the server's receipts. Only a PASS means done.",
    inputSchema: { type: "object", properties: {} },
  },
];

const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}` : JSON.stringify(v);
const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const MODEL = process.env.BLACKOUT_DONE_MODEL ?? "nvidia/Nemotron-3.5-Lightning-30B-A3B";
async function nemotron(prompt: string): Promise<string | null> {
  const key = process.env.CRUSOE_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(`${process.env.CRUSOE_BASE_URL ?? "https://api.inference.crusoecloud.com/v1"}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, temperature: 0.1, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    return j.choices?.[0]?.message?.content ?? null;
  } catch { return null; }
}
const firstJson = (s: string | null) => { if (!s) return null; const a = s.indexOf("{"), b = s.lastIndexOf("}"); if (a < 0 || b <= a) return null; try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; } };

export function createDone(db: DatabaseSync, downstream: Client, cfg: GatewayConfig) {
  db.exec(`CREATE TABLE IF NOT EXISTS contracts (mission TEXT PRIMARY KEY, goal TEXT NOT NULL, checks TEXT NOT NULL,
    hash TEXT NOT NULL, drafted_by TEXT NOT NULL, frozen_at TEXT NOT NULL)`);
  const frozen = () => db.prepare("SELECT * FROM contracts WHERE mission = ?").get(cfg.mission) as { goal: string; checks: string; hash: string; drafted_by: string; frozen_at: string } | undefined;

  async function define(args: { goal?: string; checks?: unknown }): Promise<CallToolResult> {
    const existing = frozen();
    if (existing) return text(`[blackout] done is already frozen for mission "${cfg.mission}" (sha256:${existing.hash.slice(0, 12)}, drafted by ${existing.drafted_by}). It cannot be changed.\n${existing.checks}`);
    const goal = String(args.goal ?? "").slice(0, 1000);
    let raw: unknown = args.checks, draftedBy = "caller";
    if (!raw) {
      const tools = Object.keys(cfg.sideEffects).join(", ");
      const reply = await nemotron(`You write a definition of done for an AI agent's mission, using ONLY these check kinds:
- {"kind":"exactly_once_per","tool":<side-effect tool>,"arg":<argument name>,"values":[...]} every listed value got exactly one completed call
- {"kind":"min_completed","tool":<side-effect tool>,"count":<n>}
- {"kind":"no_unknown_outcomes"}
Side-effect tools: ${tools}. Always include no_unknown_outcomes. Use exactly_once_per when the goal names specific recipients or items.
Goal: ${JSON.stringify(goal)}
Reply with JSON only: {"checks":[...]}`);
      raw = firstJson(reply)?.checks;
      draftedBy = `${MODEL} on Crusoe`;
      if (!raw) return text("[blackout] could not draft a definition of done (no CRUSOE_API_KEY, or the model reply was not valid). Pass `checks` explicitly.", true);
    }
    const parsed = Checks.safeParse(raw);
    if (!parsed.success) return text(`[blackout] rejected: checks must use the allowed vocabulary (${parsed.error.issues[0]?.message}).`, true);
    const checks = parsed.data;
    if (!checks.some((c) => c.kind === "no_unknown_outcomes")) checks.push({ kind: "no_unknown_outcomes" }); // mandatory
    const body = canonical({ mission: cfg.mission, goal, checks });
    const hash = createHash("sha256").update(body).digest("hex");
    db.prepare("INSERT INTO contracts (mission, goal, checks, hash, drafted_by, frozen_at) VALUES (?, ?, ?, ?, ?, ?)").run(cfg.mission, goal, JSON.stringify(checks), hash, draftedBy, new Date().toISOString());
    return text(`[blackout] definition of done frozen (sha256:${hash.slice(0, 12)}, drafted by ${draftedBy}). Only blackout_check_done can say this mission is done.\n${JSON.stringify(checks)}`);
  }

  async function check(): Promise<CallToolResult> {
    const c = frozen();
    if (!c) return text("[blackout] NOT DONE: no definition of done is frozen yet. Call blackout_define_done first.", true);
    if (createHash("sha256").update(canonical({ mission: cfg.mission, goal: c.goal, checks: JSON.parse(c.checks) })).digest("hex") !== c.hash) return text("[blackout] NOT DONE: the frozen definition was modified. Refusing to verify.", true);
    const checks = JSON.parse(c.checks) as DoneCheck[];
    const ops = db.prepare("SELECT op_id, tool, args, status FROM ops WHERE mission = ?").all(cfg.mission) as { op_id: string; tool: string; args: string; status: string }[];
    const done = ops.filter((o) => o.status === "done");
    const lines: string[] = [];
    let pass = true;
    for (const k of checks) {
      if (k.kind === "no_unknown_outcomes") {
        const bad = ops.filter((o) => o.status !== "done");
        lines.push(`${bad.length ? "✗" : "✓"} no unknown or unfinished side effects${bad.length ? `: ${bad.map((b) => `${b.tool} ${b.op_id} (${b.status})`).join(", ")}` : ""}`);
        pass &&= !bad.length;
      } else if (k.kind === "min_completed") {
        const n = done.filter((o) => o.tool === k.tool).length;
        lines.push(`${n >= k.count ? "✓" : "✗"} at least ${k.count} completed ${k.tool} (found ${n})`);
        pass &&= n >= k.count;
      } else {
        const rule = cfg.sideEffects[k.tool];
        for (const v of k.values) {
          const mine = done.filter((o) => o.tool === k.tool && JSON.parse(o.args)?.[k.arg] === v);
          let ok = mine.length === 1, why = mine.length === 1 ? "1 completed" : `${mine.length} completed`;
          // Independent evidence: ask the server's own receipt tool, not just our journal.
          if (ok && rule?.receipt) {
            const r = (await downstream.callTool({ name: rule.receipt.tool, arguments: { [rule.receipt.arg]: mine[0].op_id } })) as CallToolResult;
            if (r.isError) { ok = false; why = "journal says done but the server has no receipt"; } else why += ", receipt confirmed";
          }
          lines.push(`${ok ? "✓" : "✗"} ${k.tool} ${k.arg}=${v}: ${why}`);
          pass &&= ok;
        }
      }
    }
    let summary = "";
    if (!pass) {
      const s = await nemotron(`In two short sentences for an on-call human, summarise what is unfinished and what to check next. Facts only:\n${lines.join("\n")}`);
      if (s) summary = `\nEscalation summary (drafted by ${MODEL} on Crusoe; the verdict above is from code): ${s.trim()}`;
    }
    return text(`[blackout] ${pass ? "DONE: verified by code" : "NOT DONE: escalate to a human"} · contract sha256:${c.hash.slice(0, 12)}\n${lines.join("\n")}${summary}`, !pass);
  }

  return { define, check };
}
