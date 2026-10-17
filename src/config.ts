import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VAR = process.env.BLACKOUT_VAR_DIR ? path.resolve(process.env.BLACKOUT_VAR_DIR) : path.join(ROOT, "var");

// Three separate failure/trust domains on disk:
//   target/      the service being repaired (its DB, logs, and the workspace agents may edit)
//   blackout/    Blackout's own mission journal and frozen contracts (never agent-writable)
//   harness/     fault-injection controls (never agent-visible)
export const PATHS = {
  var: VAR,
  targetDir: path.join(VAR, "target"),
  targetDb: path.join(VAR, "target", "service.db"),
  targetLog: path.join(VAR, "target", "service.log"),
  targetPid: path.join(VAR, "target", "supervisor.pid"),
  workspace: path.join(VAR, "target", "workspace"),
  targetConfig: path.join(VAR, "target", "workspace", "config.json"),
  blackoutDir: path.join(VAR, "blackout"),
  journalDb: path.join(VAR, "blackout", "journal.db"),
  contractsDir: path.join(VAR, "blackout", "contracts"),
  harnessDir: path.join(VAR, "harness"),
  hooks: path.join(VAR, "harness", "hooks.json"),
  harnessLog: path.join(VAR, "harness", "events.log"),
  results: path.join(ROOT, "results"),
};

export const PORTS = {
  target: Number(process.env.BLACKOUT_TARGET_PORT ?? 7401),
  harness: Number(process.env.BLACKOUT_HARNESS_PORT ?? 7402),
};

export const TARGET_URL = `http://127.0.0.1:${PORTS.target}`;
export const HARNESS_URL = `http://127.0.0.1:${PORTS.harness}`;
