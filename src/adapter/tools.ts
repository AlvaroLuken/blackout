// Target adapter for docprint: the only operations a repair worker can perform.
// Each tool has a Zod schema; arguments are validated before anything runs.
// Logical boundary only (path and field allowlists), not OS-level isolation.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PATHS, TARGET_URL } from "../config.ts";
import type { Journal } from "../store/journal.ts";

export type ToolCtx = {
  missionId: string;
  generation: number;
  journal: Journal;
  useJournal: boolean; // false in the ablation baseline
};

const MAX_OUT = 4000;
export function redact(s: string) {
  return s
    .replace(/(Bearer\s+)[\w.\-~+/=]{8,}/gi, "$1[redacted]")
    .replace(/\b(sk|key|token)[-_][\w-]{12,}\b/gi, "[redacted]")
    .replace(/(api[_-]?key"?\s*[:=]\s*"?)[^"\s,]+/gi, "$1[redacted]");
}
export function clip(v: unknown) {
  const s = redact(typeof v === "string" ? v : JSON.stringify(v));
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `... [truncated ${s.length - MAX_OUT} chars]` : s;
}

async function http(method: string, p: string, body?: unknown) {
  const r = await fetch(TARGET_URL + p, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  let json: any = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

export function resolveWorkspacePath(rel: string): string {
  if (typeof rel !== "string" || rel.length > 200 || rel.includes("\0")) throw new Error("invalid path");
  const root = fs.realpathSync(PATHS.workspace);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("path escapes the workspace");
  if (!fs.existsSync(abs)) throw new Error("no such file");
  if (fs.lstatSync(abs).isSymbolicLink()) throw new Error("symlinks are not allowed");
  if (fs.realpathSync(abs) !== abs) throw new Error("path resolves outside the workspace");
  return abs;
}

function readConfig() { return JSON.parse(fs.readFileSync(PATHS.targetConfig, "utf8")); }
function getAt(obj: any, ptr: string[]) { return ptr.reduce((o, k) => (o == null ? undefined : o[k]), obj); }

async function waitForBoot(prevBoot: string | null, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const h = await http("GET", "/health");
      if (h.status === 200 && h.body?.boot_id !== prevBoot) return h.body;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("service did not come back after restart");
}

const NoArgs = z.object({}).strict();

export const TOOLS = {
  check_health: {
    description: "GET /health on the service. Liveness only; it does not prove jobs work.",
    schema: NoArgs,
    run: async () => http("GET", "/health"),
  },
  read_logs: {
    description: "Read the last N service log lines (JSON lines), optionally filtered by level.",
    schema: z.object({ tail: z.number().int().min(1).max(100).default(30), level: z.enum(["error", "warn", "info"]).optional() }).strict(),
    run: async (a: { tail: number; level?: string }) => {
      const lines = fs.readFileSync(PATHS.targetLog, "utf8").trim().split("\n").filter(Boolean);
      const sel = a.level ? lines.filter((l) => l.includes(`"level":"${a.level}"`)) : lines;
      return sel.slice(-a.tail).join("\n");
    },
  },
  list_workspace: {
    description: "List files in the service workspace (config and docs).",
    schema: NoArgs,
    run: async () => fs.readdirSync(PATHS.workspace).filter((f) => !fs.lstatSync(path.join(PATHS.workspace, f)).isSymbolicLink()),
  },
  read_workspace_file: {
    description: "Read a file inside the service workspace by relative path, e.g. config.json or SERVICE.md.",
    schema: z.object({ path: z.string().min(1).max(200) }).strict(),
    run: async (a: { path: string }) => fs.readFileSync(resolveWorkspacePath(a.path), "utf8").slice(0, 8000),
  },
  patch_config: {
    description: "Set one existing leaf field in config.json, addressed by dotted path (e.g. 'a.b'). The new value must have the same type as the old one. Takes effect after restart_service.",
    schema: z.object({ field: z.string().regex(/^[a-z_]+(\.[a-z_]+){0,3}$/), value: z.union([z.string().max(100), z.number(), z.boolean()]) }).strict(),
    sideEffect: true,
    run: async (a: { field: string; value: string | number | boolean }, ctx: ToolCtx) => {
      const cfg = readConfig();
      const ptr = a.field.split(".");
      const old = getAt(cfg, ptr);
      if (old === undefined || typeof old === "object") throw new Error(`'${a.field}' is not an existing leaf field`);
      if (typeof old !== typeof a.value) throw new Error(`type mismatch: '${a.field}' is ${typeof old}`);
      const opId = `${ctx.missionId}-cfg-${randomUUID().slice(0, 8)}`;
      if (ctx.useJournal) ctx.journal.recordIntent(ctx.missionId, ctx.generation, opId, "patch_config", a.field, a);
      const parent = getAt(cfg, ptr.slice(0, -1)) ?? cfg;
      parent[ptr[ptr.length - 1]] = a.value;
      fs.writeFileSync(PATHS.targetConfig, JSON.stringify(cfg, null, 2) + "\n");
      if (ctx.useJournal) ctx.journal.settleAction(opId, "acked", { old, new: a.value });
      return { field: a.field, old, new: a.value, note: "restart_service to apply" };
    },
  },
  restart_service: {
    description: "Restart the service process so it reloads config. Waits until it is back.",
    schema: NoArgs,
    sideEffect: true,
    run: async (_a: unknown, ctx: ToolCtx) => {
      const before = (await http("GET", "/health").catch(() => null))?.body?.boot_id ?? null;
      const opId = `${ctx.missionId}-restart-${randomUUID().slice(0, 8)}`;
      if (ctx.useJournal) ctx.journal.recordIntent(ctx.missionId, ctx.generation, opId, "restart_service", "docprint", { before });
      await http("POST", "/admin/restart").catch(() => null);
      const h = await waitForBoot(before);
      if (ctx.useJournal) ctx.journal.settleAction(opId, "acked", { boot_id: h.boot_id });
      return { restarted: true, boot_id: h.boot_id, version: h.version };
    },
  },
  run_test_job: {
    description: "Submit a throwaway test job through the public API and process it. Returns HTTP status and, on success, the delivered payload. Test jobs are outside the batch.",
    schema: z.object({ text: z.string().min(1).max(300) }).strict(),
    run: async (a: { text: string }, ctx: ToolCtx) => {
      const c = await http("POST", "/jobs", { text: a.text, probe: true });
      if (c.status !== 201) return { create_status: c.status, body: c.body };
      const p = await http("POST", `/jobs/${c.body.id}/process`, { op_id: `${ctx.missionId}-test-${randomUUID().slice(0, 8)}` });
      if (p.status !== 200) return { job_id: c.body.id, process_status: p.status, body: p.body };
      return { job_id: c.body.id, process_status: 200, receipt: p.body.receipt };
    },
  },
  list_jobs: {
    description: "List batch jobs and their status (test jobs excluded).",
    schema: z.object({ status: z.enum(["pending", "failed", "done"]).optional() }).strict(),
    run: async (a: { status?: string }) => {
      const r = await http("GET", "/jobs");
      const jobs = (r.body?.jobs ?? []).filter((j: any) => !j.probe && (!a.status || j.status === a.status));
      return { count: jobs.length, jobs: jobs.map((j: any) => ({ id: j.id, status: j.status })) };
    },
  },
  get_receipts: {
    description: "List the service's committed receipts for one job (op_id, delivery_id, committed_at).",
    schema: z.object({ job_id: z.string().regex(/^[\w-]{1,40}$/) }).strict(),
    run: async (a: { job_id: string }) => (await http("GET", `/receipts?job_id=${encodeURIComponent(a.job_id)}`)).body,
  },
  process_jobs: {
    description: "Process batch jobs through the service (each delivers to the ledger). Max 20 per call.",
    schema: z.object({ job_ids: z.array(z.string().regex(/^job-[\w-]{1,30}$/)).min(1).max(20) }).strict(),
    sideEffect: true,
    run: async (a: { job_ids: string[] }, ctx: ToolCtx) => {
      const out: unknown[] = [];
      for (const jobId of a.job_ids) out.push(await processOne(jobId, ctx));
      return out;
    },
  },
  finish_assignment: {
    description: "End this assignment and report back to the coordinator.",
    schema: z.object({ summary: z.string().max(800), believes_done: z.boolean() }).strict(),
    run: async (a: unknown) => a,
  },
} as const;

export type ToolName = keyof typeof TOOLS;

async function processOne(jobId: string, ctx: ToolCtx) {
  let opId: string;
  if (ctx.useJournal) {
    // Blackout protocol: never start a second logical delivery for a job the
    // journal already knows about. Reuse the op_id of an unfinished attempt so
    // the target's idempotency key absorbs any replay.
    const prior = ctx.journal.actions(ctx.missionId).filter((x) => x.kind === "process_job" && x.target_ref === jobId);
    const settled = prior.find((x) => x.status === "acked" || x.status === "reconciled_done");
    if (settled) return { job_id: jobId, skipped: "already delivered per journal + receipt", op_id: settled.op_id };
    const retry = prior.find((x) => x.status === "reconciled_absent" || x.status === "failed");
    opId = retry?.op_id ?? `${ctx.missionId}-${jobId}-${randomUUID().slice(0, 6)}`;
    if (retry) ctx.journal.settleAction(opId, "intent", { retry_generation: ctx.generation });
    else ctx.journal.recordIntent(ctx.missionId, ctx.generation, opId, "process_job", jobId, { job_id: jobId });
  } else {
    opId = `${ctx.missionId}-${jobId}-${randomUUID().slice(0, 6)}`;
  }
  const r = await http("POST", `/jobs/${jobId}/process`, { op_id: opId });
  if (ctx.useJournal) ctx.journal.settleAction(opId, r.status === 200 ? "acked" : "failed", { status: r.status, body: r.body });
  return { job_id: jobId, op_id: opId, status: r.status, replayed: r.body?.replayed ?? undefined, error: r.status !== 200 ? r.body : undefined };
}

// Runs at worker start in journal mode. Uses only target receipts and target
// state as evidence. A missing local ack never counts as proof of failure.
export async function reconcile(ctx: ToolCtx) {
  const report: { op_id: string; kind: string; target_ref: string; outcome: string }[] = [];
  for (const a of ctx.journal.unsettled(ctx.missionId)) {
    let outcome: "reconciled_done" | "reconciled_absent" | "unknown" = "unknown";
    try {
      if (a.kind === "process_job") {
        const r = await http("GET", `/receipts/${encodeURIComponent(a.op_id)}`);
        outcome = r.status === 200 ? "reconciled_done" : r.status === 404 ? "reconciled_absent" : "unknown";
      } else if (a.kind === "patch_config") {
        const args = JSON.parse((ctx.journal.db.prepare("SELECT args FROM actions WHERE op_id = ?").get(a.op_id) as any).args);
        outcome = getAt(readConfig(), String(args.field).split(".")) === args.value ? "reconciled_done" : "reconciled_absent";
      } else if (a.kind === "restart_service") {
        // Restarting again is harmless; record what we can observe.
        const h = await http("GET", "/health");
        outcome = h.status === 200 ? "reconciled_done" : "unknown";
      }
    } catch { outcome = "unknown"; }
    ctx.journal.settleAction(a.op_id, outcome, { reconciled_by_generation: ctx.generation });
    report.push({ op_id: a.op_id, kind: a.kind, target_ref: a.target_ref, outcome });
  }
  return report;
}

export function toolSpecs(names: ToolName[] = Object.keys(TOOLS) as ToolName[]) {
  return names.map((n) => ({
    type: "function" as const,
    function: { name: n, description: TOOLS[n].description, parameters: z.toJSONSchema(TOOLS[n].schema, { target: "draft-7" }) as Record<string, unknown> },
  }));
}

export async function runTool(name: string, rawArgs: unknown, ctx: ToolCtx): Promise<{ ok: boolean; output: string; parsed?: unknown }> {
  if (!(name in TOOLS)) return { ok: false, output: `unknown tool '${name}'. Allowed: ${Object.keys(TOOLS).join(", ")}` };
  const t = TOOLS[name as ToolName];
  const parsed = t.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, output: `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  try {
    const res = await (t.run as (a: any, c: ToolCtx) => Promise<unknown>)(parsed.data, ctx);
    return { ok: true, output: clip(res), parsed: res };
  } catch (e) {
    return { ok: false, output: `tool error: ${(e as Error).message}` };
  }
}
