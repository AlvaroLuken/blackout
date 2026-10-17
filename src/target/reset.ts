// Rebuild the target service's world from scratch: healthy config, a batch of
// synthetic jobs, and a few jobs already delivered before the incident.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PATHS } from "../config.ts";
import { HEALTHY_CONFIG, computePayload } from "./compute.ts";

export const BATCH = [
  "Quarterly maintenance window for the east pumping station",
  "Invoice 4471 from Café Ñandú, net 30",
  "Shift handover:   two  valves  replaced on line B",
  "Customer asked to move delivery to Thursday morning",
  "Résumé received for the night-shift operator role",
  "Sensor 12 reported drift above tolerance at 03:10",
  "Reminder: renew the fire inspection certificate",
  "Pallet count mismatch in bay 7, recount scheduled",
  "Weekly safety briefing notes, attendance 14 of 16",
  "Supplier confirmed replacement bearings ship Friday",
];
export const PRE_DELIVERED = 3;

const SERVICE_DOC = `# docprint service

docprint fingerprints short documents and delivers the result to the ledger.

## Output contract
Each job produces one ledger delivery with payload:
  { "job_id": string, "fingerprint": string, "word_count": number }

- Normalization: Unicode NFC, lowercase, collapse runs of whitespace to one space, trim.
- fingerprint: SHA-256 of the normalized text, lowercase hex (64 chars).
- word_count: number of space-separated tokens after normalization.

## Operations
- Config lives in workspace/config.json and is read once at startup. Restart after editing.
- POST /jobs/{id}/process requires an op_id. Reusing an op_id is safe: the service returns the
  original receipt. A new op_id for an already-delivered job creates a second delivery
  (the ledger is at-least-once).
- GET /receipts/{op_id} returns the receipt for a committed operation, or 404.
`;

const OUTBOX_OPS = `
## Operations (outbox mode)
- Config lives in workspace/config.json and is read once at startup. Restart after editing.
- POST /jobs/{id}/process requires an op_id and delivers downstream. The job stays "pending"
  until the caller confirms with POST /jobs/{id}/ack {op_id}. Reusing an op_id is safe: the
  service returns the original receipt. A new op_id for a job that was already delivered
  creates a second delivery.
- GET /receipts/{op_id} returns the receipt for a committed operation, or 404. Receipts
  cannot be listed by job.
`;

export function resetTarget(profile: "ledger" | "outbox" = "ledger") {
  fs.rmSync(PATHS.targetDir, { recursive: true, force: true });
  fs.mkdirSync(PATHS.workspace, { recursive: true });
  fs.writeFileSync(PATHS.targetConfig, JSON.stringify(HEALTHY_CONFIG, null, 2) + "\n");
  fs.writeFileSync(`${PATHS.workspace}/SERVICE.md`, profile === "outbox" ? SERVICE_DOC.split("## Operations")[0] + OUTBOX_OPS.trimStart() : SERVICE_DOC);
  fs.writeFileSync(PATHS.targetProfile, JSON.stringify({ profile }));
  fs.writeFileSync(PATHS.targetLog, "");

  const db = new DatabaseSync(PATHS.targetDb);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE jobs (id TEXT PRIMARY KEY, text TEXT NOT NULL, probe INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
      op_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE receipts (op_id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
      delivery_id INTEGER NOT NULL, committed_at TEXT NOT NULL);
  `);
  const t0 = "2026-10-17T08:00:00.000Z";
  BATCH.forEach((text, i) => {
    const id = `job-${String(i + 1).padStart(3, "0")}`;
    const done = i < PRE_DELIVERED;
    db.prepare("INSERT INTO jobs (id, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, text, done ? "done" : "pending", t0, done ? t0 : null);
    if (done) {
      const op = `seed-${id}`;
      const d = db.prepare("INSERT INTO deliveries (job_id, op_id, payload, created_at) VALUES (?, ?, ?, ?)").run(id, op, JSON.stringify(computePayload(id, text, HEALTHY_CONFIG)), t0);
      db.prepare("INSERT INTO receipts (op_id, job_id, delivery_id, committed_at) VALUES (?, ?, ?, ?)").run(op, id, Number(d.lastInsertRowid), t0);
    }
  });
  db.close();
}
