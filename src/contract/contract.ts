// Completion contract: the model proposes it, the adapter forces mandatory
// checks in, and it is frozen (hashed, written outside every agent-writable
// path) before any repair action runs.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PATHS } from "../config.ts";

// Allowlisted probe vocabulary. The model can only pick from these; it never writes checker code.
export const CheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fresh_job_e2e") }),
  z.object({ kind: z.literal("all_scope_jobs_valid_output") }),
  z.object({ kind: z.literal("no_duplicate_deliveries") }),
  z.object({ kind: z.literal("preexisting_outputs_intact") }),
  z.object({ kind: z.literal("no_unaccounted_work") }),
  z.object({ kind: z.literal("health_ok") }),
  z.object({ kind: z.literal("no_errors_since_boot") }),
  z.object({ kind: z.literal("expected_scope_size"), count: z.number().int().min(0).max(1000) }),
]);
export type Check = z.infer<typeof CheckSchema>;
export const CHECK_KINDS = CheckSchema.options.map((o) => o.shape.kind.value);

// Adapter-supplied invariants for the docprint target. Cannot be removed.
export const MANDATORY: Check[] = [
  { kind: "fresh_job_e2e" },
  { kind: "all_scope_jobs_valid_output" },
  { kind: "no_duplicate_deliveries" },
  { kind: "preexisting_outputs_intact" },
  { kind: "no_unaccounted_work" },
];

export const ProposalSchema = z.object({
  goal_summary: z.string().min(1).max(400),
  assumptions: z.array(z.string().max(300)).max(8).default([]),
  checks: z.array(CheckSchema).max(16),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export type ScopeSnapshot = {
  job_ids: string[];
  preexisting: { job_id: string; delivery_id: number; payload_sha256: string }[];
};

export type FrozenContract = {
  mission_id: string;
  goal: string;
  goal_summary: string;
  assumptions: string[];
  scope: ScopeSnapshot;
  checks: (Check & { source: "mandatory" | "model" })[];
  rejected_checks: unknown[];
  frozen_at: string;
  hash: string;
};

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function contractHash(c: Omit<FrozenContract, "hash"> | FrozenContract): string {
  const { hash: _h, ...rest } = c as FrozenContract;
  return createHash("sha256").update(canonical(rest)).digest("hex");
}

export function freezeContract(missionId: string, goal: string, rawProposal: unknown, scope: ScopeSnapshot): FrozenContract {
  // Validate each proposed check independently so one bad entry is visible, not fatal.
  const raw = (rawProposal ?? {}) as Record<string, unknown>;
  const proposedChecks = Array.isArray(raw.checks) ? raw.checks : [];
  const accepted: Check[] = [];
  const rejected: unknown[] = [];
  for (const c of proposedChecks) {
    const r = CheckSchema.safeParse(c);
    r.success ? accepted.push(r.data) : rejected.push(c);
  }
  const proposal = ProposalSchema.parse({ ...raw, checks: accepted });

  const checks: FrozenContract["checks"] = MANDATORY.map((c) => ({ ...c, source: "mandatory" as const }));
  for (const c of proposal.checks) {
    if (checks.some((x) => canonical({ ...x, source: undefined }) === canonical({ ...c, source: undefined }))) continue;
    if (MANDATORY.some((m) => m.kind === c.kind)) continue;
    checks.push({ ...c, source: "model" });
  }
  const body: Omit<FrozenContract, "hash"> = {
    mission_id: missionId,
    goal,
    goal_summary: proposal.goal_summary,
    assumptions: proposal.assumptions,
    scope,
    checks,
    rejected_checks: rejected,
    frozen_at: new Date().toISOString(),
  };
  const frozen: FrozenContract = { ...body, hash: contractHash(body) };
  fs.mkdirSync(PATHS.contractsDir, { recursive: true });
  const file = path.join(PATHS.contractsDir, `${missionId}.json`);
  fs.writeFileSync(file, JSON.stringify(frozen, null, 2));
  fs.chmodSync(file, 0o444);
  return frozen;
}

export function loadFrozenContract(missionId: string): FrozenContract {
  const c = JSON.parse(fs.readFileSync(path.join(PATHS.contractsDir, `${missionId}.json`), "utf8")) as FrozenContract;
  if (contractHash(c) !== c.hash) throw new Error(`contract ${missionId} hash mismatch: refusing to verify against a modified contract`);
  return c;
}
