// Side-by-side race: Blackout (journal + reconciliation) vs the same agent
// without them. Same model, tools, target profile, fault and kill point.
// Each side gets its own target, harness, journal and ports, run as separate
// process trees. Output is drawn in two live columns.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.ts";

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const profile = flag("profile", "outbox");
const fault = flag("fault", Math.random() < 0.5 ? "bad_digest" : "bad_unicode");
const killAfter = flag("kill-after", "2");
const inject = argv.includes("--inject");
const policy = flag("policy", "llm");

type Side = { title: string; mode: string; lines: string[]; done: boolean; summary: string[]; color: string };
const sides: Side[] = [
  { title: "BLACKOUT  (journal + receipt reconciliation)", mode: "journal", lines: [], done: false, summary: [], color: "\x1b[1;36m" },
  { title: "PLAIN AGENT  (same model, no journal)", mode: "baseline", lines: [], done: false, summary: [], color: "\x1b[1;35m" },
];

const RESET = "\x1b[0m";
function paint(s: string) {
  if (/SIGKILL|died|DUPLICATE|duplicates=[1-9]|x no_duplicate/.test(s)) return `\x1b[31m${s}${RESET}`;
  if (/ESCALATE|claim rejected|Claim rejected/i.test(s)) return `\x1b[33m${s}${RESET}`;
  if (/reconciled|PASS|DONE:|VERIFIED/.test(s)) return `\x1b[32m${s}${RESET}`;
  if (/contract frozen|\[coordinator\]/.test(s)) return `\x1b[36m${s}${RESET}`;
  return s;
}
// Strip noisy parts so one event fits one column line.
function compact(s: string) {
  return s
    .replace(/^\s+/, "")
    .replace(/\[worker\.g(\d)\]/, "w$1")
    .replace(/\[controller\]/, "ctl")
    .replace(/\[verifier\]/, "ver")
    .replace(/\[coordinator\]/, "coord")
    .replace(/\[harness\]/, "harness")
    .replace(/ -> ok /, " ok ")
    .replace(/\{"status":200,"body":/, "{")
    .replace(/sha256:([0-9a-f]{12})/, "sha256:$1");
}

function visibleLen(s: string) { return s.replace(/\x1b\[[0-9;]*m/g, "").length; }
function fit(s: string, w: number) {
  const plain = s.length > w ? s.slice(0, w - 1) + "…" : s;
  return paint(plain) + " ".repeat(Math.max(0, w - visibleLen(plain)));
}

function draw() {
  const cols = process.stdout.columns || 160;
  const rows = process.stdout.rows || 45;
  const w = Math.floor((cols - 3) / 2);
  const body = rows - 6;
  let out = "\x1b[H\x1b[2J";
  out += `\x1b[1mBlackout race\x1b[0m  profile=${profile}  fault=hidden from agents  kill after delivery #${killAfter}${inject ? "  planted log instructions: ON" : ""}  ${policy === "test" ? "policy=DETERMINISTIC TEST POLICY" : "model=Nemotron 3.5 Lightning on Crusoe"}\n`;
  out += sides.map((s) => s.color + fit(s.title, w).replace(/\x1b\[[0-9;]*m/g, "") + RESET).join(" │ ") + "\n";
  out += "─".repeat(w) + "─┼─" + "─".repeat(w) + "\n";
  const views = sides.map((s) => {
    const src = s.done && s.summary.length ? [...s.lines.slice(-(body - s.summary.length - 1)), "", ...s.summary] : s.lines;
    return src.slice(-body);
  });
  for (let i = 0; i < body; i++) out += fit(views[0][i] ?? "", w) + " │ " + fit(views[1][i] ?? "", w) + "\n";
  process.stdout.write(out);
}

const runs: { file?: string }[] = [{}, {}];
let finished = 0;
sides.forEach((side, i) => {
  const varDir = path.join(ROOT, "var", `race-${side.mode}`);
  fs.rmSync(varDir, { recursive: true, force: true });
  const args = ["--import", "tsx", "--disable-warning=ExperimentalWarning", path.join(ROOT, "src/cli.ts"), "mission", "--mode", side.mode, "--profile", profile, "--fault", fault, "--kill-after", killAfter, "--policy", policy, ...(inject ? ["--inject"] : [])];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, BLACKOUT_VAR_DIR: varDir, BLACKOUT_TARGET_PORT: String(7411 + i * 10), BLACKOUT_HARNESS_PORT: String(7412 + i * 10), BLACKOUT_RPM: "30", BLACKOUT_RESULTS_DIR: path.join(ROOT, "results", "race") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  let inSummary = false;
  const onData = (d: Buffer) => {
    buf += d.toString();
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const raw of parts) {
      if (!raw.trim()) continue;
      if (raw.includes("mission summary")) { inSummary = true; continue; }
      if (inSummary) {
        if (raw.startsWith("result file:")) runs[i].file = raw.split(/\s+/).pop();
        side.summary.push(raw.replace(/\s{2,}/g, " "));
      } else side.lines.push(compact(raw));
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", () => { side.done = true; finished++; if (finished === 2) end(); });
});

const timer = setInterval(draw, 250);
function end() {
  clearInterval(timer);
  draw();
  process.stdout.write("\n");
  for (const [i, s] of sides.entries()) {
    const f = runs[i].file ? path.join(ROOT, runs[i].file!) : null;
    if (!f || !fs.existsSync(f)) continue;
    const r = JSON.parse(fs.readFileSync(f, "utf8"));
    console.log(`${s.color}${s.mode.padEnd(9)}${RESET} ${r.status.toUpperCase().padEnd(10)} valid ${r.final_verdict.progress.valid_jobs}/${r.final_verdict.progress.scope_jobs}  duplicates committed: ${r.target_facts.duplicate_committed_deliveries}  calls ${r.usage.calls}  $${(r.usage.est_usd ?? 0).toFixed(4)}`);
  }
  process.exit(0);
}
process.on("SIGINT", () => { process.stdout.write(RESET + "\n"); process.exit(130); });
