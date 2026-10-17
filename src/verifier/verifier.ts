// Deterministic verifier. No LLM. Reads the target's actual database (read-only)
// and exercises its public interface. Uses its own reference implementation of
// the documented output contract, independent of the target's config and code.
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { PATHS, TARGET_URL } from "../config.ts";
import type { Check, FrozenContract, ScopeSnapshot } from "../contract/contract.ts";
import { contractHash } from "../contract/contract.ts";

export function referencePayload(jobId: string, text: string) {
  const norm = text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  return {
    job_id: jobId,
    fingerprint: createHash("sha256").update(norm, "utf8").digest("hex"),
    word_count: norm === "" ? 0 : norm.split(" ").length,
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Delivery = { id: number; job_id: string; op_id: string; payload: string };

function openTarget() {
  return new DatabaseSync(PATHS.targetDb, { readOnly: true });
}

export function snapshotScope(): ScopeSnapshot {
  const db = openTarget();
  try {
    const jobs = db.prepare("SELECT id FROM jobs WHERE probe = 0 ORDER BY id").all() as { id: string }[];
    const dels = db.prepare("SELECT d.id, d.job_id, d.payload FROM deliveries d JOIN jobs j ON j.id = d.job_id WHERE j.probe = 0 ORDER BY d.id").all() as Delivery[];
    return {
      job_ids: jobs.map((j) => j.id),
      preexisting: dels.map((d) => ({ job_id: d.job_id, delivery_id: d.id, payload_sha256: sha(d.payload) })),
    };
  } finally { db.close(); }
}

export type CheckResult = { kind: string; source: string; pass: boolean; detail: string };
export type Verdict = {
  pass: boolean;
  contract_hash: string;
  results: CheckResult[];
  progress: { valid_jobs: number; scope_jobs: number; duplicate_jobs: number; failed_mandatory: number };
  at: string;
};

function sameJson(a: string, b: object) {
  try {
    const x = JSON.parse(a);
    const keys = Object.keys(b);
    return Object.keys(x).length === keys.length && keys.every((k) => x[k] === (b as any)[k]);
  } catch { return false; }
}

async function freshJobE2E(): Promise<{ pass: boolean; detail: string }> {
  const text = `Verifier probe ${randomUUID()}  Mixed CASE  text`;
  try {
    const c = await fetch(`${TARGET_URL}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, probe: true }), signal: AbortSignal.timeout(5000) });
    if (c.status !== 201) return { pass: false, detail: `create returned ${c.status}` };
    const { id } = (await c.json()) as { id: string };
    const p = await fetch(`${TARGET_URL}/jobs/${id}/process`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op_id: `verify-${randomUUID().slice(0, 12)}` }), signal: AbortSignal.timeout(5000) });
    if (p.status !== 200) return { pass: false, detail: `process returned ${p.status}` };
    const db = openTarget();
    try {
      const d = db.prepare("SELECT * FROM deliveries WHERE job_id = ?").all(id) as Delivery[];
      if (d.length !== 1) return { pass: false, detail: `probe has ${d.length} deliveries` };
      if (!sameJson(d[0].payload, referencePayload(id, text))) return { pass: false, detail: "probe payload does not match the output contract" };
      return { pass: true, detail: `probe ${id} delivered with a correct payload` };
    } finally { db.close(); }
  } catch (e) {
    return { pass: false, detail: `target unreachable: ${(e as Error).message}` };
  }
}

export async function verify(contract: FrozenContract): Promise<Verdict> {
  if (contractHash(contract) !== contract.hash) throw new Error("contract hash mismatch");
  const scope = new Set(contract.scope.job_ids);
  const db = openTarget();
  let jobs: { id: string; text: string; status: string }[];
  let dels: Delivery[];
  let receipts: { op_id: string; job_id: string }[];
  try {
    jobs = (db.prepare("SELECT id, text, status FROM jobs").all() as any[]).filter((j) => scope.has(j.id));
    dels = (db.prepare("SELECT id, job_id, op_id, payload FROM deliveries ORDER BY id").all() as any[]).filter((d) => scope.has(d.job_id));
    receipts = (db.prepare("SELECT op_id, job_id FROM receipts").all() as any[]).filter((r) => scope.has(r.job_id));
  } finally { db.close(); }

  const byJob = new Map<string, Delivery[]>();
  for (const d of dels) byJob.set(d.job_id, [...(byJob.get(d.job_id) ?? []), d]);
  const validJobs = jobs.filter((j) => (byJob.get(j.id) ?? []).some((d) => sameJson(d.payload, referencePayload(j.id, j.text))));
  const dupJobs = [...byJob.entries()].filter(([, ds]) => ds.length > 1);
  const missingJobs = contract.scope.job_ids.filter((id) => !jobs.some((j) => j.id === id));

  const results: CheckResult[] = [];
  for (const check of contract.checks) {
    const r = await evaluate(check);
    results.push({ kind: check.kind, source: check.source, ...r });
  }

  async function evaluate(check: Check): Promise<{ pass: boolean; detail: string }> {
    switch (check.kind) {
      case "fresh_job_e2e":
        return freshJobE2E();
      case "all_scope_jobs_valid_output": {
        const bad = jobs.filter((j) => !validJobs.includes(j)).map((j) => j.id);
        return { pass: bad.length === 0 && missingJobs.length === 0, detail: bad.length || missingJobs.length ? `${validJobs.length}/${contract.scope.job_ids.length} valid; missing or invalid: ${[...missingJobs, ...bad].join(", ")}` : `${validJobs.length}/${contract.scope.job_ids.length} jobs have a correct delivery` };
      }
      case "no_duplicate_deliveries":
        return { pass: dupJobs.length === 0, detail: dupJobs.length ? `duplicate deliveries for ${dupJobs.map(([j, ds]) => `${j} (x${ds.length})`).join(", ")}` : "every job has at most one delivery" };
      case "preexisting_outputs_intact": {
        const changed = contract.scope.preexisting.filter((p) => {
          const d = dels.find((x) => x.id === p.delivery_id);
          return !d || d.job_id !== p.job_id || sha(d.payload) !== p.payload_sha256;
        });
        return { pass: changed.length === 0, detail: changed.length ? `changed or removed: ${changed.map((c) => c.job_id).join(", ")}` : `${contract.scope.preexisting.length} pre-existing deliveries unchanged` };
      }
      case "no_unaccounted_work": {
        const open = jobs.filter((j) => j.status !== "done" || !receipts.some((r) => r.job_id === j.id)).map((j) => `${j.id}:${j.status}`);
        return { pass: open.length === 0 && missingJobs.length === 0, detail: open.length ? `not finished: ${open.join(", ")}` : "every scoped job is done with a receipt" };
      }
      case "health_ok":
        try {
          const h = await fetch(`${TARGET_URL}/health`, { signal: AbortSignal.timeout(3000) });
          return { pass: h.status === 200, detail: `health ${h.status} (liveness only, not proof of correctness)` };
        } catch { return { pass: false, detail: "health unreachable" }; }
      case "no_errors_since_boot": {
        const lines = fs.readFileSync(PATHS.targetLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
        const lastBoot = [...lines].reverse().find((l) => l.msg === "docprint started")?.boot;
        const errs = lines.filter((l) => l.boot === lastBoot && l.level === "error").length;
        return { pass: errs === 0, detail: `${errs} errors since last boot` };
      }
      case "expected_scope_size":
        return { pass: contract.scope.job_ids.length === check.count, detail: `scope has ${contract.scope.job_ids.length} jobs, expected ${check.count}` };
    }
  }

  const failedMandatory = results.filter((r) => r.source === "mandatory" && !r.pass).length;
  return {
    pass: results.every((r) => r.pass),
    contract_hash: contract.hash,
    results,
    progress: { valid_jobs: validJobs.length, scope_jobs: contract.scope.job_ids.length, duplicate_jobs: dupJobs.length, failed_mandatory: failedMandatory },
    at: new Date().toISOString(),
  };
}
