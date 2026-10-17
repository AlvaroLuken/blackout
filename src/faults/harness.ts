// Fault-injection harness. External test machinery: agents never see these
// fault names, the hooks file, or this process. It breaks the target and
// SIGKILLs the repair worker at the target's after-commit failpoint.
import http from "node:http";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PATHS, PORTS } from "../config.ts";
import type { ServiceConfig } from "../target/compute.ts";

export const FAULTS = {
  // Health stays 200, every job fails. A restart alone does not fix it.
  bad_digest: (c: ServiceConfig) => { c.version = "2.3.2"; c.fingerprint.algorithm = "sha265"; },
  // Same symptom class, different key: health 200, jobs 500 with a RangeError.
  bad_unicode: (c: ServiceConfig) => { c.version = "2.3.2"; c.normalize.unicode = "NFC2"; },
  // Jobs "succeed" but payloads are wrong. Only payload verification catches it.
  silent_case: (c: ServiceConfig) => { c.version = "2.3.2"; c.normalize.lowercase = false; },
} as const;
export type FaultName = keyof typeof FAULTS;

export function harnessEvent(event: string, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(PATHS.harnessDir, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...extra });
  fs.appendFileSync(PATHS.harnessLog, line + "\n");
  return line;
}

export function injectFault(name: FaultName) {
  const cfg = JSON.parse(fs.readFileSync(PATHS.targetConfig, "utf8"));
  FAULTS[name](cfg);
  fs.writeFileSync(PATHS.targetConfig, JSON.stringify(cfg, null, 2) + "\n");
  harnessEvent("fault_injected", { fault: name });
}

export function armKill(commitNumber: number) {
  fs.mkdirSync(PATHS.harnessDir, { recursive: true });
  fs.writeFileSync(PATHS.hooks, JSON.stringify({ armed: true, kill_on_commit_number: commitNumber, armed_at: new Date().toISOString() }));
  harnessEvent("kill_armed", { commit_number: commitNumber });
}

export function disarm() {
  try { fs.writeFileSync(PATHS.hooks, JSON.stringify({ armed: false })); } catch {}
}

function currentWorkerPid(): number | null {
  if (!fs.existsSync(PATHS.journalDb)) return null;
  const db = new DatabaseSync(PATHS.journalDb, { readOnly: true });
  try {
    const row = db.prepare("SELECT pid FROM workers WHERE state = 'running' ORDER BY generation DESC LIMIT 1").get() as { pid: number } | undefined;
    return row?.pid ?? null;
  } finally { db.close(); }
}

export function serveHarness() {
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/failpoint") {
      let body = "";
      for await (const c of req) body += c;
      const info = JSON.parse(body || "{}");
      disarm();
      const pid = currentWorkerPid();
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
          console.log(harnessEvent("worker_sigkilled", { pid, ...info }));
        } catch (e) {
          console.log(harnessEvent("kill_failed", { pid, error: (e as Error).message }));
        }
      } else {
        console.log(harnessEvent("kill_skipped_no_worker", info));
      }
      // Give the OS a moment so the worker is gone before the target answers.
      await new Promise((r) => setTimeout(r, 100));
      res.writeHead(200).end("{}");
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(PORTS.harness, "127.0.0.1");
  return server;
}

if (process.argv[1]?.endsWith("harness.ts") && process.argv[2] === "serve") serveHarness();
