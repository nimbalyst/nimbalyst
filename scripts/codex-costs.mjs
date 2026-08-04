#!/usr/bin/env node
// codex-costs — a claude-code-costs equivalent for OpenAI Codex CLI logs.
//
// Scans ~/.codex/sessions/**/*.jsonl rollout logs, sums per-turn token usage
// (input / cached-input / output) from `token_count` events, prices them with
// the rate table below, and reports last-day / last-7-day / last-30-day totals
// plus an HTML report.
//
// IMPORTANT: These are API-EQUIVALENT estimates, not your actual (subscription)
// bill. Codex models here are mostly non-public ids; every model defaults to
// public GPT-5 rates. Edit MODEL_PRICES to refine.
//
// Usage: node scripts/codex-costs.mjs [--days N] [--no-open] [--sessions-dir DIR]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFile } from 'node:child_process';

// Rates are USD per 1,000,000 tokens.
const GPT5 = { input: 1.25, cached: 0.125, output: 10.0 };
const MODEL_PRICES = {
  // Public GPT-5 tier — used as the default for every model id.
  default: GPT5,
  // Add per-model overrides here as real rates become known, e.g.:
  // 'gpt-5-codex': { input: 1.25, cached: 0.125, output: 10.0 },
};

function priceFor(model) {
  return MODEL_PRICES[model] || MODEL_PRICES.default;
}

function parseArgs(argv) {
  const a = { days: 30, open: true, sessionsDir: path.join(os.homedir(), '.codex', 'sessions') };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--no-open') a.open = false;
    else if (v === '--days') a.days = Number(argv[++i]);
    else if (v === '--sessions-dir') a.sessionsDir = argv[++i];
  }
  return a;
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

// One row per session; also emit per-turn dated cost points for daily bucketing.
async function processFile(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let model = 'unknown';
  let cwd = null;
  let startTime = null;
  const points = []; // { date, cost, in, cached, out, model }
  const totals = { cost: 0, in: 0, cached: 0, out: 0 };

  for await (const line of rl) {
    if (!line) continue;
    // Cheap prefilter before JSON.parse.
    if (line.indexOf('token_count') < 0 &&
        line.indexOf('session_meta') < 0 &&
        line.indexOf('turn_context') < 0) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload || {};
    if (o.type === 'session_meta') {
      startTime = o.timestamp || p.timestamp || startTime;
      cwd = p.cwd || cwd;
      continue;
    }
    if (p.model) model = p.model; // turn_context carries the active model
    if (p.type === 'token_count') {
      const u = p.info && p.info.last_token_usage;
      if (!u) continue;
      const ts = o.timestamp || startTime;
      const date = (ts || '').slice(0, 10);
      const uncachedIn = Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0));
      const cached = u.cached_input_tokens || 0;
      const out = u.output_tokens || 0; // includes reasoning tokens
      const r = priceFor(model);
      const cost = (uncachedIn * r.input + cached * r.cached + out * r.output) / 1e6;
      points.push({ date, cost, in: uncachedIn, cached, out, model });
      totals.cost += cost; totals.in += uncachedIn; totals.cached += cached; totals.out += out;
    }
  }
  if (points.length === 0) return null;
  const project = cwd ? path.basename(cwd) : 'unknown';
  return { file: path.basename(file), project, cwd, model, startTime, points, totals };
}

function fmt$(n) { return '$' + n.toFixed(2); }
function fmtM(n) { return (n / 1e6).toFixed(1) + 'M'; }
function daysAgoISO(n) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv);
  console.log('Analyzing Codex costs from', args.sessionsDir, '...\n');
  const files = [...walk(args.sessionsDir)];
  const sessions = [];
  let done = 0;
  for (const f of files) {
    const s = await processFile(f);
    if (s) sessions.push(s);
    if (++done % 100 === 0) process.stdout.write(`\rProcessed ${done}/${files.length} files...`);
  }
  process.stdout.write(`\rProcessed ${files.length}/${files.length} files.        \n`);

  const byDay = new Map();     // date -> {cost,in,cached,out,sessions:Set}
  const byModel = new Map();   // model -> {cost,in,cached,out}
  let grand = { cost: 0, in: 0, cached: 0, out: 0 };
  for (const s of sessions) {
    for (const pt of s.points) {
      const d = byDay.get(pt.date) || { cost: 0, in: 0, cached: 0, out: 0, sessions: new Set() };
      d.cost += pt.cost; d.in += pt.in; d.cached += pt.cached; d.out += pt.out; d.sessions.add(s.file);
      byDay.set(pt.date, d);
      const m = byModel.get(pt.model) || { cost: 0, in: 0, cached: 0, out: 0 };
      m.cost += pt.cost; m.in += pt.in; m.cached += pt.cached; m.out += pt.out;
      byModel.set(pt.model, m);
      grand.cost += pt.cost; grand.in += pt.in; grand.cached += pt.cached; grand.out += pt.out;
    }
  }

  const dates = [...byDay.keys()].sort();
  const windowSum = (fromISO) => {
    const a = { cost: 0, in: 0, cached: 0, out: 0, sessions: new Set() };
    for (const [d, v] of byDay) if (d >= fromISO) {
      a.cost += v.cost; a.in += v.in; a.cached += v.cached; a.out += v.out;
      for (const s of v.sessions) a.sessions.add(s);
    }
    return a;
  };
  const today = daysAgoISO(0);
  const dayW = byDay.get(today) || { cost: 0, in: 0, cached: 0, out: 0, sessions: new Set() };
  const w7 = windowSum(daysAgoISO(6));
  const w30 = windowSum(daysAgoISO(29));

  console.log('=== Codex Cost Summary (API-equivalent estimate) ===\n');
  console.log(`Total Cost:     ${fmt$(grand.cost)}  (${dates[0]} -> ${dates[dates.length - 1]})`);
  console.log(`Sessions:       ${sessions.length}   Rollout files: ${files.length}\n`);
  const row = (label, w) =>
    console.log(`${label.padEnd(16)} ${fmt$(w.cost).padStart(10)}   in ${fmtM(w.in).padStart(7)}  cached ${fmtM(w.cached).padStart(8)}  out ${fmtM(w.out).padStart(6)}`);
  row(`Last day`, dayW);
  row(`Last 7 days`, w7);
  row(`Last 30 days`, w30);
  console.log('\nBy model:');
  for (const [m, v] of [...byModel].sort((a, b) => b[1].cost - a[1].cost))
    console.log(`  ${m.padEnd(18)} ${fmt$(v.cost).padStart(10)}   in ${fmtM(v.in)}  cached ${fmtM(v.cached)}  out ${fmtM(v.out)}`);

  // HTML report
  const daily = dates.map((d) => {
    const v = byDay.get(d);
    return { date: d, cost: +v.cost.toFixed(4), sessions: v.sessions.size };
  });
  const topSessions = [...sessions]
    .sort((a, b) => b.totals.cost - a.totals.cost)
    .slice(0, 50)
    .map((s) => ({ file: s.file, project: s.project, model: s.model, date: (s.startTime || '').slice(0, 10), cost: +s.totals.cost.toFixed(4) }));
  const html = renderHtml({ grand, daily, topSessions, byModel: [...byModel].sort((a, b) => b[1].cost - a[1].cost), dayW, w7, w30, dates });
  const out = path.join(os.tmpdir(), `codex-costs-report-${dates[dates.length - 1]}.html`);
  fs.writeFileSync(out, html);
  console.log(`\nHTML report: ${out}`);
  if (args.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execFile(opener, [out], () => {});
    console.log('Opening report in browser...');
  }
}

function renderHtml({ grand, daily, topSessions, byModel, dayW, w7, w30 }) {
  const money = (n) => '$' + n.toFixed(2);
  const rows = topSessions.map((s) =>
    `<tr><td>${s.date}</td><td>${s.project}</td><td>${s.model}</td><td class="r">${money(s.cost)}</td></tr>`).join('');
  const modelRows = byModel.map(([m, v]) =>
    `<tr><td>${m}</td><td class="r">${money(v.cost)}</td><td class="r">${(v.in / 1e6).toFixed(1)}M</td><td class="r">${(v.cached / 1e6).toFixed(1)}M</td><td class="r">${(v.out / 1e6).toFixed(1)}M</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Codex Costs</title>
<style>
body{font:14px -apple-system,system-ui,sans-serif;margin:2rem;background:#0f1115;color:#e6e6e6}
h1{font-size:20px} .cards{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0}
.card{background:#1a1d24;border:1px solid #2a2e37;border-radius:10px;padding:1rem 1.25rem;min-width:150px}
.card .v{font-size:22px;font-weight:600} .card .l{color:#8a92a0;font-size:12px}
table{border-collapse:collapse;width:100%;margin-top:.5rem} th,td{padding:6px 10px;border-bottom:1px solid #262a33;text-align:left}
th{color:#8a92a0;font-weight:500} td.r,th.r{text-align:right}
.note{color:#8a92a0;font-size:12px;margin:.5rem 0 1.5rem} canvas{max-width:100%}
</style></head><body>
<h1>Codex Cost Report</h1>
<div class="note">API-equivalent estimate (GPT-5 public rates applied to all models). Not your actual subscription bill.</div>
<div class="cards">
<div class="card"><div class="v">${money(dayW.cost)}</div><div class="l">Last day</div></div>
<div class="card"><div class="v">${money(w7.cost)}</div><div class="l">Last 7 days</div></div>
<div class="card"><div class="v">${money(w30.cost)}</div><div class="l">Last 30 days</div></div>
<div class="card"><div class="v">${money(grand.cost)}</div><div class="l">All time</div></div>
</div>
<canvas id="c" height="90"></canvas>
<h2>By model</h2>
<table><thead><tr><th>Model</th><th class="r">Cost</th><th class="r">Input</th><th class="r">Cached</th><th class="r">Output</th></tr></thead><tbody>${modelRows}</tbody></table>
<h2>Top sessions</h2>
<table><thead><tr><th>Date</th><th>Project</th><th>Model</th><th class="r">Cost</th></tr></thead><tbody>${rows}</tbody></table>
<script>
const daily=${JSON.stringify(daily)};
const cv=document.getElementById('c'),ctx=cv.getContext('2d');
function draw(){const w=cv.width=cv.clientWidth,h=cv.height;const max=Math.max(1,...daily.map(d=>d.cost));
ctx.clearRect(0,0,w,h);const bw=w/daily.length;
daily.forEach((d,i)=>{const bh=(d.cost/max)*(h-20);ctx.fillStyle='#4f8cff';ctx.fillRect(i*bw+1,h-bh,bw-2,bh);});}
draw();addEventListener('resize',draw);
</script>
</body></html>`;
}

main().catch((e) => { console.error(e); process.exit(1); });
