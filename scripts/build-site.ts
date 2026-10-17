// Builds the static public site in site/: the landing page (site/index.html,
// hand-written) plus race.html, a copy of the live web view rewired to replay a
// recorded live run (results/race/replay-backup.json) instead of starting processes.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.ts";

const out = path.join(ROOT, "site");
fs.mkdirSync(out, { recursive: true });

let html = fs.readFileSync(path.join(ROOT, "src/web/index.html"), "utf8");
const swap = (from: string, to: string) => {
  if (!html.includes(from)) throw new Error(`build-site: pattern not found: ${from.slice(0, 60)}`);
  html = html.replace(from, to);
};

swap(`const es = new EventSource("/events");\nes.onmessage = (e) => handle(JSON.parse(e.data));`, `// Static site: no server. Replays a recorded live run at 2x, under the replay banner.
async function playRecorded() {
  const rec = await (await fetch("replay.json")).json();
  $("start").disabled = true;
  handle({ type: "replay", recorded_at: rec.recorded_at, speed: 2 });
  for (const ev of rec.events) setTimeout(() => handle(ev.msg), ev.t / 2);
  setTimeout(() => { $("start").disabled = false; }, rec.events.at(-1).t / 2 + 800);
}`);
html = html.replace(/\$\("start"\)\.addEventListener\("click", async \(\) => \{[\s\S]*?\n\}\);/, `$("start").addEventListener("click", playRecorded);`);
swap(`fetch("/measured")`, `fetch("measured.json")`);
swap(`const t = await (await fetch("/crusoe")).json();`, `const t = await (await fetch("crusoe.json")).json();`);
swap(`<span class="ck">Crusoe metrics API · our model · 5-min window, ~1 min lag</span>`, `<span class="ck">Crusoe metrics API · our model · snapshot from a live run, 12:31 PT</span>`);
swap(`<button class="start" id="start" type="button">Run the race</button>`, `<button class="start" id="start" type="button">▶ Play the recorded race</button>`);
swap(`<span class="status" id="status">Ready. Press Run: both agents get the same broken sender.</span>`, `<span class="status" id="status">A real live run from the event, replayed at 2× speed. Run it live yourself: see the GitHub README.</span>`);
swap(`</style>`, `#plug, #replay, .toggle { display: none !important; }\n</style>`);
fs.writeFileSync(path.join(out, "race.html"), html);

fs.copyFileSync(path.join(ROOT, "results/race/replay-backup.json"), path.join(out, "replay.json"));

// Same aggregation as the live server's /measured.
const rows: Record<string, unknown>[] = [];
for (const f of fs.readdirSync(path.join(ROOT, "results")).filter((f) => /^eval-(outbox|ledger)-\d.*\.json$/.test(f))) {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, "results", f), "utf8"));
  if (d.pairs < 10) continue;
  for (const mode of ["journal", "baseline"]) {
    const r = d.runs.filter((x: any) => x.mode === mode);
    rows.push({
      profile: d.profile, mode, runs: r.length,
      verified: r.filter((x: any) => x.verified).length,
      dup_runs: r.filter((x: any) => x.duplicate_committed > 0).length,
      dup_deliveries: r.reduce((s: number, x: any) => s + x.duplicate_committed, 0),
      false_success: r.filter((x: any) => x.false_success).length,
      mean_usd: r.reduce((s: number, x: any) => s + (x.est_usd ?? 0), 0) / r.length,
    });
  }
}

// MCP gateway eval rows (latest n>=10 run): "verified" = runs where every customer got exactly one email.
const gwf = fs.readdirSync(path.join(ROOT, "results")).filter((f) => /^gateway-eval-.*\.json$/.test(f)).sort().reverse();
for (const f of gwf) {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, "results", f), "utf8"));
  if ((d.summary?.[0]?.runs ?? 0) < 10) continue;
  for (const sm of d.summary) rows.push({ profile: "MCP gateway", mode: sm.arm === "gateway" ? "journal" : "baseline", runs: sm.runs, verified: sm.runs - sm.runs_with_duplicate - (sm.missing > 0 ? 1 : 0), dup_runs: sm.runs_with_duplicate, dup_deliveries: sm.duplicate_emails, false_success: sm.false_done, mean_usd: sm.mean_usd });
  break;
}
fs.writeFileSync(path.join(out, "measured.json"), JSON.stringify(rows));
// Values measured by the Crusoe metrics API during our live runs (12:31 PT, Oct 17).
fs.writeFileSync(path.join(out, "crusoe.json"), JSON.stringify({ rpm: 40.4, ttft_ms: 717, tok_s: 141 }));
console.log("site built:", fs.readdirSync(out).join(", "));
