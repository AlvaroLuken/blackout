// Keeps the docprint server running. A restart request makes the server exit; the supervisor brings it back.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PATHS, ROOT } from "../config.ts";

fs.mkdirSync(PATHS.targetDir, { recursive: true });
fs.writeFileSync(PATHS.targetPid, String(process.pid));

let child: ChildProcess | null = null;
let stopping = false;

function start() {
  child = spawn(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", path.join(ROOT, "src/target/server.ts")], {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  child.on("exit", () => {
    child = null;
    if (!stopping) setTimeout(start, 200);
  });
}

function stop() {
  stopping = true;
  child?.kill("SIGTERM");
  try { fs.unlinkSync(PATHS.targetPid); } catch {}
  setTimeout(() => process.exit(0), 100);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
start();
