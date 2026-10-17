// Terminal view of the side-by-side race (see raceRunner.ts). Two live columns
// of short events plus live delivered/duplicate counters from each target DB.
import { startRace, counters, MODES, type Mode, type Tone } from "./raceRunner.ts";

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const policy = flag("policy", "llm");

const RESET = "\x1b[0m";
const TONE: Record<Tone, string> = { kill: "\x1b[31m", bad: "\x1b[31m", good: "\x1b[32m", warn: "\x1b[33m", info: "\x1b[36m", plain: "" };
const TITLE: Record<Mode, string> = { journal: "\x1b[1;36mBLACKOUT (journal + receipts)", baseline: "\x1b[1;35mPLAIN AGENT (no journal)" };
const lines: Record<Mode, { text: string; tone: Tone }[]> = { journal: [], baseline: [] };
const summary: Record<Mode, string[]> = { journal: [], baseline: [] };
let exited = 0;

const vlen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
function cell(text: string, t: Tone, w: number) {
  const plain = text.length > w ? text.slice(0, w - 1) + "…" : text;
  return (TONE[t] ? TONE[t] + plain + RESET : plain) + " ".repeat(Math.max(0, w - plain.length));
}

function draw() {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  const w = Math.floor((cols - 3) / 2);
  const body = rows - 7;
  let out = "\x1b[H\x1b[2J";
  out += `\x1b[1mBLACKOUT RACE\x1b[0m  same model · same fault · same kill  ${policy === "test" ? "(DETERMINISTIC TEST POLICY)" : "· Nemotron 3.5 Lightning on Crusoe"}\n`;
  out += MODES.map((m) => { const t = TITLE[m]; return t + RESET + " ".repeat(Math.max(0, w - vlen(t))); }).join(" │ ") + "\n";
  out += "─".repeat(w) + "─┼─" + "─".repeat(w) + "\n";
  const views = MODES.map((m) => [...lines[m], ...(summary[m].length ? [{ text: "", tone: "plain" as Tone }, ...summary[m].map((s) => ({ text: s, tone: (s.startsWith("✔") ? "good" : s.startsWith("⚑") ? "warn" : "plain") as Tone }))] : [])].slice(-body));
  for (let i = 0; i < body; i++) out += MODES.map((_, k) => { const l = views[k][i]; return l ? cell(l.text, l.tone, w) : " ".repeat(w); }).join(" │ ") + "\n";
  out += "─".repeat(w) + "─┼─" + "─".repeat(w) + "\n";
  out += MODES.map((m) => {
    const c = counters(m);
    if (!c) return " ".repeat(w);
    const text = ` delivered ${c.delivered}/${c.total}   got it twice ${c.dup}`;
    return `\x1b[1m delivered ${c.delivered}/${c.total}   ${c.dup ? "\x1b[41;97m" : "\x1b[32m"}got it twice ${c.dup}${RESET}` + " ".repeat(Math.max(0, w - text.length));
  }).join(" │ ") + "\n";
  process.stdout.write(out);
}

startRace({
  profile: flag("profile", "outbox"),
  fault: flag("fault", Math.random() < 0.5 ? "bad_digest" : "bad_unicode"),
  killAfter: Number(flag("kill-after", "2")) || null,
  inject: argv.includes("--inject"),
  policy,
}, (e) => {
  if (e.type === "line") lines[e.mode].push({ text: e.text, tone: e.tone });
  if (e.type === "summary") summary[e.mode] = [e.status === "VERIFIED" ? "✔ VERIFIED" : `⚑ ${e.status}`, e.calls != null ? `${e.calls} Nemotron calls · ${e.usd}` : "", e.elapsed ? `${e.elapsed} total` : ""].filter(Boolean);
  if (e.type === "exit" && ++exited === 2) { clearInterval(timer); draw(); process.stdout.write("\n"); process.exit(0); }
});

const timer = setInterval(draw, 250);
process.on("SIGINT", () => { process.stdout.write(RESET + "\n"); process.exit(130); });
