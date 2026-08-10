---
description: Investigate a Nimbalyst performance problem (freeze, lag, idle CPU, slow op, memory growth) with measured evidence before proposing a fix.
---

# Investigate Performance

You are a performance investigator for Nimbalyst. The user has a performance complaint — a freeze, a hitch, typing lag, a slow operation, high idle CPU, or memory growth. Your job is to **measure it, name the specific offender with numbers, and propose a ranked fix** — then ask how to proceed.

Do NOT jump to a fix. Do NOT theorize from reading code alone. Every performance claim in this repo's history that was made from "the code path looks wrong" has been wrong at least as often as it was right. The deliverable is numbers.

## User's Complaint

$ARGUMENTS

---

## Prime directives

1. **Run your own observation commands.** Never ask the user to paste logs, run `ps`, open Chrome DevTools, or click through the Developer Dashboard. You have log tools, `database_query`, `renderer_eval`, `Bash`, and heap-snapshot tools. See `docs/DEBUGGING_LOGS.md`.
2. **Identify the hot process before theorizing.** Main, renderer, GPU, a *non-focused* renderer, the SQLite worker, and a helper process all fail differently. Sample first.
3. **Separate the victim from the blocker.** Both database backends are single-lane. A query reported at 30s is usually 1s of work behind 29s of queue-wait. Fixing the victim fixes nothing.
4. **Baseline, then delta.** Capture a number before the fix and the same number after. A before/after table is the deliverable. "Looks memoized now" is not evidence.
5. **One change at a time.** Re-measure between changes or you will not know which one worked.
6. **Never run `npm run dev`. Never restart Nimbalyst without explicit permission.**

---

## Step 1 — Classify the symptom

Pick the instrument from the symptom. Ask the user only if genuinely ambiguous.

| Symptom | First instruments |
| --- | --- |
| App freezes / "window became unresponsive" / beachball | `[PERF] Event loop lag` in main.log, auto-captured `.cpuprofile`, SQLite worker hot shapes |
| One operation is slow (open session, open project, switch project, save) | `[IpcSlow]`, `database:getPerformance` byShape, `EXPLAIN QUERY PLAN` |
| Slow/janky startup, "takes forever to become usable" | `[StartupSlow]`, `[StartupMaintenanceGate]`, main.log timeline from launch |
| Typing lag, scroll jank, navigation repaints the whole window | renderer probes + a render-count vitest probe |
| High CPU / fan / battery drain while idle | `ps` per-PID sampling, rAF/animation probes, hidden-window audit |
| Memory grows over hours, eventual crash | `capture_heap_snapshot` / `analyze_heap_snapshot`, `dev:get-system-stats` deltas |
| Sync/collab slowness or cost | `wrangler tail`, per-message round-trip counting, `docs/CLOUDFLARE_USAGE_COST_LESSONS.md` |

Check `mcp__nimbalyst-extension-dev__get_environment_info` first: dev vs packaged, and **which database backend is live** (PGLite or better-sqlite3). Several instruments below are backend-specific.

---

## Step 2 — Gather evidence

### 2a. Main-process log greps (always do these)

The app self-instruments. Use `get_main_process_logs` with `searchTerm`, and `Bash` + `grep` against `~/Library/Application Support/@nimbalyst/electron/logs/main.log` when you need context lines.

| Grep | What it means | Source |
| --- | --- | --- |
| `[PERF] Event loop lag` | Main-thread block. Sampled every 250ms, logged at >=500ms. **A single line reports the whole blocked interval** — the previous lag line's timestamp brackets when the freeze began. | `main/utils/performanceMonitor.ts` |
| `[PERF] High CPU usage` | 10s sampler, >50% main-process CPU, with heap/handles/requests counts | same |
| `[PERF] Captured CPU profile (trigger=…) -> <path>` | A `.cpuprofile` was auto-written. Triggers: sustained >80% CPU, or a single lag >=2000ms. | same |
| `[PERF] SQLite worker hot shapes (elu=…)` | **Top-10 query shapes by total time, dumped from inside the worker.** This usually answers "what is hot?" without opening any profile. Read this before anything else on a DB-shaped problem. | `database/sqlite/worker/sqliteWorker.ts` |
| `[IpcSlow] <channel> took Nms` | Any `safeHandle` invocation over the threshold | `main/utils/ipcRegistry.ts` |
| `[StartupSlow] <name> took Nms` | Startup phase over threshold | `main/utils/startupTiming.ts` |
| `[StartupMaintenanceGate]` | When deferred maintenance was released and how long each task took | `main/services/startupMaintenanceGate.ts` |
| `[SQLite Backup] Online backup complete {sizeBytes: …}` | **Database size.** A multi-GB DB amplifies every query and the backup itself competes for the worker. | |
| `Queue full, dropping oldest event` | A bounded work queue is overflowing (file-edit attribution has done this under multi-session load) | |
| `MaxListenersExceededWarning` | Listener leak — see `docs/IPC_LISTENERS.md` | |
| `took \d\d\d\dms` | Catch-all for four-digit durations anyone logged | |

### 2b. CPU profiles — read them yourself

Profiles land in `~/Library/Application Support/@nimbalyst/electron/logs/`:
- `cpu-<iso>.cpuprofile` — main process
- `cpu-sqlite-worker-<iso>.cpuprofile` — the SQLite worker isolate (the main-side profile shows this as idle, so a saturated worker is invisible without it)

That directory holds thousands of files. **Sort by mtime and take only the ones bracketing the incident**: `ls -t ~/Library/Application\ Support/@nimbalyst/electron/logs/*.cpuprofile | head -5`.

A `.cpuprofile` is JSON (`nodes`, `samples`, `timeDeltas`). Do not hand it to the user for Chrome DevTools — aggregate it yourself with a throwaway script in `temptests/`:

```js
// temptests/readprofile.mjs — self-time by function, top 25
import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const byId = new Map(p.nodes.map(n => [n.id, n]));
const self = new Map();
for (let i = 0; i < p.samples.length; i++) {
  const id = p.samples[i], dt = p.timeDeltas[i] ?? 0;
  self.set(id, (self.get(id) ?? 0) + dt);
}
const rows = [...self].map(([id, us]) => {
  const f = byId.get(id)?.callFrame ?? {};
  return { ms: Math.round(us / 1000), fn: f.functionName || '(anon)', at: `${f.url ?? ''}:${f.lineNumber ?? ''}` };
}).sort((a, b) => b.ms - a.ms).slice(0, 25);
console.table(rows);
```

Also walk parents for aggregated (total) time when self-time is spread across a hot callee like a JSON parse or a diff routine.

### 2c. Database instrumentation

Reach these through `renderer_eval` (they are ordinary IPC channels — the Developer Dashboard is just a UI over them; you do not need the window):

```js
await window.electronAPI.invoke('database:getPerformance', { slowLimit: 50 })
// -> { snapshot: { byShape: [{ shape, count, totalMs, p99, maxMs, lastCallSite }], ... }, slowQueries: [...] }

await window.electronAPI.invoke('dev:get-system-stats')
// -> { fileWatchers: { activeWorkspaces, workspaces, totalSubscribers },
//      process: { memoryRssMB, heapUsedMB, activeHandles },
//      ipc: { registeredHandlers, channelStats: [{ channel, callCount, slowCount }] },
//      database: { queryStats }, windows: [...] }

await window.electronAPI.invoke('dev:get-atomfamily-stats')
// -> per-atomFamily live instance counts (relays to window.__atomFamilyStats())
```

`byShape` sorted by `totalMs` with `count` is the N+1 detector: **1,170 calls of the same shape totalling 15.8s** is the signature. `lastCallSite` names the caller.

`database:getPerformance` exists **only on the better-sqlite3 backend**. On PGLite fall back to `database:getStats` / the `database.queryStats` block of `dev:get-system-stats` (rolling 5-minute window), plus the `[IpcSlow]` log and renderer-side IPC counting below.

For schema/row-count questions use `mcp__nimbalyst-extension-dev__database_query` (SELECT only). **Never open the database file with node or a CLI** — both backends hold exclusive locks and you will corrupt it.

Check index coverage before blaming volume. `database_query` only permits statements starting with `SELECT`, so run the plan as a subquery-free `SELECT` where possible, or read the index definitions out of the schema and reason against them; on SQLite you can also confirm coverage from the worker's hot-shape report (a shape with a high `p99` and a low `count` is usually a scan). Watch for a query whose JSON accessor (`->>` vs `json_extract()`) does not match the partial index expression character-for-character — the index is then silently skipped.

### 2d. Renderer probes (`renderer_eval`)

**Caveat that has burned prior sessions:** `renderer_eval` targets the focused workspace window. It cannot reach the org window, the offscreen editor window, or headless browser host windows — and Chromium throttles rAF and CSS animations in *hidden* windows, so a probe on a backgrounded window reads as perfectly quiescent while that window is the one burning CPU. Confirm `document.visibilityState` and `document.hasFocus()` in the probe output.

Paint / animation load:

```js
// Frame + mutation + animation census over 1s
await new Promise(r => {
  let raf = 0, mut = 0;
  const t = (function tick(){ raf++; return requestAnimationFrame(tick); })();
  const mo = new MutationObserver(rs => { mut += rs.length; });
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  setTimeout(() => { cancelAnimationFrame(t); mo.disconnect(); r(); }, 1000);
});
({
  visibility: document.visibilityState, focused: document.hasFocus(),
  infiniteAnimations: document.getAnimations()
    .filter(a => a.effect?.getTiming().iterations === Infinity)
    .map(a => ({ name: a.animationName, el: a.effect?.target?.className?.slice?.(0, 60) })),
})
```

Long tasks (jank):

```js
window.__longTasks = [];
new PerformanceObserver(l => window.__longTasks.push(...l.getEntries().map(e => ({ ms: Math.round(e.duration), at: e.startTime }))))
  .observe({ entryTypes: ['longtask'] });
// ...have the user exercise the flow, or drive it yourself, then read window.__longTasks
```

IPC volume from the renderer (catches broadcast storms and per-item fan-out):

```js
window.__ipc = {};
const orig = window.electronAPI.invoke;
window.electronAPI.invoke = (ch, ...a) => { window.__ipc[ch] = (window.__ipc[ch] ?? 0) + 1; return orig(ch, ...a); };
// ...exercise the flow, then read window.__ipc, then restore
```

Also useful: `window.__atomFamilyStats()`, `window.__editorRegistry`, `performance.memory`.

### 2e. React re-render measurement

**Measure it live first.** The app ships a render profiler in dev builds — a `__REACT_DEVTOOLS_GLOBAL_HOOK__` shim that reads the committed fiber tree and reports, per component, how many times it rendered and *why*. Recording is off until you start it. Full guide: `docs/RENDER_PERFORMANCE.md`.

```js
// renderer_eval — start() is async (it loads the atom-write profiler)
window.__nimWarm = window.__renderProfiler.start()
// ... exercise the app ...
window.__renderProfiler.stop()   // or .snapshot() to peek without stopping
```

Read **renders per commit**, not the raw total. A low commit rate with a huge render count means one state change is repainting the window. The snapshot's `reasons` field names the cause: `unstable prop identity: onToggle` (inline lambda/object in the parent — the most fixable), `parent rendered (props identical)` (pure waste), `mount` in bulk (subtree recreated, usually key churn or a conditional render where CSS `display` belongs). The `atoms` section ranks atom writes, which is usually where the real driver is.

Check `window.visibilityState` in the snapshot before concluding anything — a throttled background window reads as quiescent.

**Then pin the fix with a render budget.** `measureRenders()` from `renderer/devtools/renderBudget.ts` runs the same profiler under jsdom:

```tsx
const budget = await measureRenders(async () => { await act(async () => { /* the action */ }); });
expect(budget.rendersOf('SessionListItem'), budget.report()).toBe(1);
```

Get the red baseline first, and assert an **exact** count — `toBeLessThanOrEqual` also passes when you typo the component name and measure nothing. Flush mount effects (`await act(async () => { await Promise.resolve(); })`) before measuring, or you measure the mount. Virtualized surfaces (transcript `virtua`, session list `react-virtuoso`) don't measure honestly in jsdom — profile those live.

Prior art: `AgenticCoding/__tests__/SessionListItem.renderBudget.test.tsx` (per-session isolation, 5 rows and 50) and the older icon-counting `TeamMode/__tests__/TeamMode.renderCost.test.tsx`. Mock the narrowest module — **never `vi.mock('@nimbalyst/runtime')`** (the barrel drags in the whole Lexical tree, ~2.6s per file).

### 2f. Which process is actually hot

```bash
ps -Ao pid,pcpu,pmem,comm,args | grep -i "[N]imbalyst\|[E]lectron" | sort -k2 -rn | head -15
```

Match the PID against `--type=renderer`, `--type=gpu-process`, `--type=utility`, or the main process. A high **renderer + GPU pair** while idle means continuous painting. A high **main** with a flat renderer means the event loop or the DB worker. Sample twice, ~10s apart.

### 2g. Memory

`mcp__nimbalyst-extension-dev__capture_heap_snapshot` then `analyze_heap_snapshot`. For growth, take two snapshots minutes apart under the offending workload and diff retained sizes by constructor. Cross-check `dev:get-system-stats` (`activeHandles`, `fileWatchers.totalSubscribers`, atomFamily instance counts) — a leak usually shows up in one of those counters before it shows up in the heap.

---

## Step 3 — Check the known-offender list

Nimbalyst's performance failures repeat. Walk this list against the evidence; most investigations land on one of these.

### A. N+1 / per-item fan-out (the single most common cause here)

- **Per-entity IPC in a loop.** A batch path often already exists and the callers just don't use it — e.g. `getFilesBySessionMany` existed while five renderer callers each issued one `session-files:get-by-session` per session (~1,900 queries, 27s).
- **Per-item awaited writes.** One `INSERT … ON CONFLICT` per tracker item in a sequential `for` loop froze project open. On both backends the worker `transaction()` does not reduce round-trips — **the lever is fewer queries** (multi-row insert), not a transaction wrapper.
- **Broadcast storms.** One broadcast (`session-files:updated`, `team-inbox:state-changed`) triggers a per-entity refetch in every listener. During streaming this fires continuously. Coalesce/debounce the broadcast, or batch the refetch.
- **Duplicate init.** Two components mounting simultaneously each call the same init (six `refreshSessionList` calls in 18ms). Dedupe at the atom/store level, not by deleting one caller.
- **Per-mutation aggregate recompute** — a count/rollup query re-run on every write.

Grep shapes: `for (… of …) { await …invoke(`, `.map(async … invoke(`, `Promise.all(ids.map(`, listener handlers that call a fetch keyed by a single id.

### B. Single-lane database head-of-line blocking

- Both PGLite (PID-locked worker) and better-sqlite3 (WriteCoordinator write lane) are **single-threaded and FIFO**. Any long query stalls every other read and write.
- Startup maintenance fired un-awaited "off the critical path" still runs **on the shared worker**. A 12s `SELECT count(*) … WHERE message_kind IS NULL` full-scan over 1.3M rows once pushed six user-facing startup operations to 30–39s — nearly all of it queue-wait. Defer through `startupMaintenanceGate`, chunk, and throttle between chunks.
- Online backup of a multi-GB database running concurrently with the workload.
- **Queries that cannot use an index**: `file_path LIKE 'workspace%'` combined with a JSON-extracted field; `COUNT(DISTINCT …)` over a huge table. On SQLite, `->>` vs `json_extract()` must match the partial index expression **exactly** or the index is silently skipped.
- Database bloat amplifies but is rarely the structural cause — do not stop at "the DB is big."

### C. Excessive React rendering

- **One atom at the root.** A whole route/snapshot object read with `useAtom` in a component that renders the entire window means every change repaints everything. Fix: push consumption down into narrow derived atoms that individual rows/panes subscribe to.
- **Identity churn.** A listener replacing a whole snapshot object on every broadcast (including presence heartbeats and the window's own round trips) invalidates every memo keyed on it. Reuse `store/listeners/atomRevalidation.ts` (`isStructurallyEqual`, `setIfChanged`, `reconcileList`, `setListIfChanged`).
- **Memo deps keyed on an entire object** instead of the derived pieces actually used.
- **Remount-on-navigate.** `key={id}` (sometimes double-keyed at two levels) resets child state and refires mount-effect fetches on every switch. An adapter with no cache refetches everything when returning to a pane visited seconds ago.
- **Conditional render instead of CSS display** for mode-level components — unmount/remount loses state, re-reads preferences over IPC, and restarts timers. The repo pattern is all mode components mounted, toggled by CSS.
- **Hidden/inactive surfaces still re-rendering per keystroke** (Quick Open lag came from exactly this).
- **Self-amplifying effects** — effect writes state -> new object identity -> re-render -> effect deps changed -> effect runs again.
- Per `packages/electron/CLAUDE.md`: *if you need `React.memo` to prevent re-renders, you have the wrong architecture.* Prefer atom-level isolation; memo is the fallback for leaves.

### D. Idle CPU / continuous paint

- **Always-on render loops.** `@react-three/fiber` `<Canvas>` defaults to `frameloop="always"` — it repaints at display refresh forever while mounted. Use `frameloop="demand"` and pause when hidden.
- **Infinite CSS animations** (`animate-spin`, `animate-pulse`) on elements that are always mounted.
- **Hidden `BrowserWindow`s that are never destroyed** — an offscreen editor window whose `cleanup()` is never wired in production, a headless browser host kept composited with `showInactive()`. Check `webPreferences.backgroundThrottling` and whether teardown is actually reachable from `main/index.ts`.
- **Timers**: `setInterval` sweeps, presence heartbeats, poll loops, 60s timers restarted on every remount.
- Remember: **the hot renderer is frequently not the focused window.** Sample by PID before probing.

### E. Leaks (listeners, watchers, handles, atoms)

- `window.electronAPI.on(...)` returns an unsubscribe closure and there is no `off` — an uncalled closure leaks a listener per mount. Session switching once leaked enough to crash a window after days of uptime.
- Per-session file watchers fanning out across sessions, feeding a bounded attribution queue that overflows under multi-session load.
- Track growth with repeated `dev:get-system-stats` (`activeHandles`, `totalSubscribers`) and `dev:get-atomfamily-stats`.

### F. Startup

- Un-awaited background work on the shared worker (see B).
- Duplicate or racing init calls from sibling components mounting at the same time.
- Sync heuristics that re-push the same rows on every cold start because of a field divergence between local and server state.
- `[StartupSlow]` and the first-usable gate tell you what ran before the window was usable.

### G. Sync / collab / network

- Per-message round trips and broadcast amplification; see `docs/CLOUDFLARE_USAGE_COST_LESSONS.md`.
- Local database state is **not** server state. For collab slowness, tail the worker (`wrangler tail`, run it yourself, `run_in_background` for long tails) — do not infer server behavior from PGLite/SQLite rows.

---

## Step 4 — Check prior art before re-deriving

Several of these have already been investigated in depth. Read the relevant plan before repeating the work — and if the current complaint matches one, say so and check whether the fix regressed.

`nimbalyst-local/plans/` (and `archive/`):
`idle-cpu-secondary-render-surfaces-801.md`, `slow-session-load-sqlite-saturation.md`, `startup-worker-head-of-line-blocking.md`, `tracker-scan-nplus1-freeze-fix.md`, `external-file-change-reload-freeze-fix.md`, `session-freeze-http-529-recovery.md`, `syncmanager-startup-repush-loop.md`, `ios-session-list-performance.md`, `ai-session-search-performance.md`, `archive/database-query-performance-optimization.md`, `archive/commit-proposal-prefetch-optimization.md`.

Also: `mcp__nimbalyst-trackers__tracker_list` for prior performance bugs, and `git log --oneline -- <hot file>` when a regression is suspected (`CHANGELOG.md` records most shipped performance fixes — grep it for the subsystem).

Use `get_session_summary` / `get_workstream_overview` rather than re-reading files a prior session already covered. For wide sweeps, spawn an `Explore` agent and keep only its conclusion (see `.claude/rules/token-discipline.md`).

---

## Step 5 — Report and ask

Create a tracker bug item for the problem (per `docs/TRACKER_WORKFLOWS.md`) and link this session before proposing code changes.

Report format — compact, numbers first:

```markdown
## Symptom
[What the user sees, 1-2 sentences.]

## Measured
[The evidence. Tables of real numbers: hot query shapes with call counts and totals,
event-loop lag durations, per-PID CPU, render counts, IPC call counts. Say which
instrument produced each number.]

## Root cause
[One sentence naming the mechanism, with file:line. Then the chain of causation.
State explicitly whether the slow thing you measured is the blocker or a victim of queue-wait.]

## Ranked fixes
1. [Highest impact / lowest risk first. Each with the expected delta and what it touches.]
2. ...

## Not the cause
[Things you ruled out with evidence — saves the next session from re-checking.]
```

Then call `AskUserQuestion`:

- question: "How would you like to proceed on this performance issue?"
- options:
  - "Fix it" — apply the top-ranked fix now, with a before/after measurement
  - "Design it" — run `/design` for a multi-subsystem change (invoke it yourself, do not tell the user to)
  - "Keep measuring" — the diagnosis is not yet conclusive; name what you'd instrument next
  - "Stop here" — the report is the deliverable

---

## Rules

- **No fix without a baseline number and a matching after number.** If you cannot measure it, say so plainly rather than claiming an improvement.
- **No unverified victory.** For anything that needs a restart or a manual UI flow to confirm, the failing test comes first — see `.claude/rules/end-to-end-verification.md`.
- **Behavioral changes ship with a test.** For render-cost work that means a render-count probe; for query work, a test that asserts the batched call count.
- **Do not silently narrow scope.** If a fix only addresses one of three contributing causes, say which two remain.
- **No speculative micro-optimization.** If the profile does not show it, do not "optimize" it.
- **Do not commit.** Never `git stash`, `git reset`, or `git add -A`.
- **Never restart Nimbalyst without asking.** Renderer changes hot-reload; main-process changes need a restart the user performs.
- **Calibrated language.** State what changed and the measured numbers. No "dramatically faster," no savings claims that aren't in the measurement, and judge impact against the whole baseline, not against the piece you touched.
- Clean up any `temptests/` scratch scripts you create.
