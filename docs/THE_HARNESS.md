# The Nimbalyst Agent Harness

This document is a living catalog of everything we put **around** the AI agent to make it effective at developing Nimbalyst itself. The "harness" is the scaffolding of rules, tools, workflows, and observability that turns a general-purpose coding agent into a reliable contributor to this codebase.

**Audience:** Other developers (and contributors) joining the project who want to understand how AI sessions actually work here — what the agent reads, what tools it has, how it verifies its work, how multiple sessions coordinate. Also a checklist for ongoing harness improvements.

**Why this exists:** Without harness, a coding agent makes the same mistakes repeatedly, asks the user to run commands the agent could run itself, and ships fixes that look right but don't survive a restart. With a good harness, the agent reads relevant context up front, reaches for the right tool the first time, verifies its work end-to-end, and leaves behind a record so the next session inherits the lesson. The harness is the difference between an agent that helps and an agent that costs you time.

This doc complements [CLAUDE.md](./../CLAUDE.md) (the agent's primary instructions) and [EXTENSION_ARCHITECTURE.md](./../docs/EXTENSION_ARCHITECTURE.md) (how the product itself works). CLAUDE.md tells the agent *what to do*; this doc tells *us* what we've built to make it do that.

---

## How the harness is layered

The harness has seven distinct layers. Each addresses a different failure mode of a naive coding agent.

| Layer | What it does | Lives in |
| --- | --- | --- |
| **Instructional** | Tells the agent how to behave in this codebase | `CLAUDE.md`, `.claude/rules/`, `.claude/agent-mistakes.md`, per-user `memory/` |
| **Capability** | What the agent can do beyond reading/writing files | MCP tools (`mcp__nimbalyst-*`), Bash, native Read/Edit/Grep |
| **Workflow** | How the agent organizes a piece of work | Slash commands in `.claude/commands/`, skills, subagents |
| **Observability** | What the agent can see about runtime state | Logs, database queries, screenshots, renderer eval |
| **Verification** | How the agent confirms a fix actually works | Tests (unit + E2E), restart, AI tool simulator |
| **Coordination** | How multiple sessions, workstreams, and agents collaborate | Sessions, workstreams, kanban, meta-agent, worktrees |
| **Provenance & Tracking** | How code changes stay linked to the intent that produced them | File-edit tracking, session ↔ tracker linkage, bug / feature / decision / plan items |
| **Communication** | How the agent talks back to the user | Interactive prompts, inline charts/images, diagrams, voice |

The rest of this doc walks each layer with what we have, what it's for, and where the gaps are.

---

## 1. Instructional layer

Documents the agent reads (sometimes automatically, sometimes by reference) to know how to behave.

### `CLAUDE.md` (project root)

Primary brief. Loaded into every session's context automatically. Contains:

- **Critical Rules** block — read first. Hard constraints with past-incident citations: no `process.env` for API keys, no dynamic imports in main process, CollabV3 data isolation policy, no direct PGLite access, "always run your own observation commands" rule, "end-to-end verification before declaring victory" rule.
- **Codebase overview** — monorepo layout, extension system pointer, dev commands.
- **Cross-cutting patterns** — error handling, naming conventions, React DOM markers.
- **Documentation reference table** — points the agent at the right `docs/*.md` file when working on a specific area (extensions, IPC, editor state, transcripts, etc.). The table is the single most load-bearing piece of context: "before editing X, read docs/Y.md."
- **General guidelines** — no emojis, no time estimates, no unrequested commits, don't run `npm run dev` yourself.

### `.claude/rules/*.md`

Wildcard-imported into every session. These are short, focused rule files that elaborate on a single pattern:

- `floating-ui.md` — always use `@floating-ui/react`, never manual `position: fixed`
- `ipc-listeners.md` — components don't subscribe to IPC directly, central listeners update atoms
- `jotai.md` — derived atoms for session state, no dynamic imports inside atoms
- `editor-state.md` — editors own their content state, no lifting up
- `error-handling.md` — fail fast, validate at boundaries
- `naming-conventions.md` — camelCase for wire, snake_case for SQL
- `state-persistence.md` — use createDefault() functions, ?? operator for migration
- `electron-database.md` — TIMESTAMPTZ only, no localStorage in renderer
- `main-process-init.md` — bootstrap.ts is the only allowed dynamic-import callsite
- `extensions.md` — pointer to EXTENSION_ARCHITECTURE.md
- `ui-patterns.md` — @container queries, --nim-* CSS vars
- `help-walkthroughs.md` — data-testid required for help/tooltips
- `end-to-end-verification.md` — failing test first for restart-to-verify bugs

When a rule shows up in multiple agent-mistakes entries, it graduates from "we should remember this" to a permanent `.claude/rules/` file.

### `.claude/agent-mistakes.md`

Append-only log of specific mistakes the agent has made and the lessons. Format per entry: `## YYYY-MM-DD: <title>` + `What happened` + `Fix` + `Lesson`. New entries get prepended (newest first).

This is the institutional memory of "we already learned this." When an agent makes a mistake the user calls out, we add it here. When a mistake recurs across sessions, it gets promoted into a `.claude/rules/` file or a memory entry.

### Per-user memory at `~/.claude/projects/<workspace-slug>/memory/`

User-scoped persistent memory that loads into every session. `MEMORY.md` is the index; one file per memory.

Memory types (per the auto-memory spec):
- **user** — who the developer is, role, preferences
- **feedback** — corrections and validated approaches ("don't do X", "yes, exactly that")
- **project** — ongoing initiatives, who's doing what, deadlines
- **reference** — pointers to external systems (Linear projects, Grafana boards, Slack channels)

Memory captures *why* a rule exists, not just the rule. Every feedback entry has a **Why** and **How to apply** line so the agent can judge edge cases instead of mechanically applying it.

### Skills (CLI-managed)

User-invocable slash skills exposed by the harness itself (not project-defined commands):
- `/restart`, `/loop`, `/schedule`, `/init`, `/security-review`, `/review`, plus extension-contributed skills like `/datamodellm:datamodel` and `/extension-dev-kit:new-extension`.

Skills are different from `.claude/commands/` — skills come from installed plugins/extensions; commands are repo-local.

---

## 2. Capability layer (MCP tools)

What the agent can do beyond `Read` / `Write` / `Edit` / `Bash`. Each MCP server exposes a domain of tools.

### `mcp__nimbalyst-extension-dev` — control Nimbalyst itself

The agent can drive the Nimbalyst dev instance directly:

- `restart_nimbalyst` — restart the app (requires user permission per `restart` rule)
- `get_environment_info` — verify dev vs packaged mode before making code changes
- `get_main_process_logs` / `get_renderer_debug_logs` — read logs without the user copy-pasting
- `database_query` — query PGLite safely via IPC (NEVER open the DB file directly)
- `renderer_eval` — evaluate JS in the renderer for runtime DOM/state inspection
- `extension_build` / `extension_install` / `extension_reload` / `extension_uninstall` — iterate on extensions without the user rebuilding manually
- `extension_test_run` / `extension_test_ai_tool` / `extension_test_open_file` — exercise extension contributions
- `extension_get_status` — see whether an extension loaded correctly

These tools are the difference between "ask the user to inspect X" and "the agent inspects X." Misuse pattern to avoid: drafting "could you run X and paste the output?" — stop and run X yourself. See CLAUDE.md "Always Run Your Own Observation Commands."

The internal surface is split across several servers on one internal HTTP port; only the eager core loads every session, everything else is deferred and surfaced by ToolSearch on intent. See [INTERNAL_MCP_SERVERS.md](./INTERNAL_MCP_SERVERS.md) for the full topology.

### `mcp__nimbalyst` — eager core (in-app actions)

The only always-loaded internal surface — universal agent↔host glue.

- `AskUserQuestion`, `PromptForUserInput` — durable interactive widgets in the transcript. Use for blocking decisions / multi-field input instead of asking in chat.
- `developer_git_commit_proposal` — interactive commit widget; preferred over raw `git commit` when the user says "propose a commit" or "commit this".
- `display_to_user` — inline charts (bar / line / pie / area / scatter with error bars) and images. Always prefer a chart over a markdown table for numeric data.
- `capture_editor_screenshot` — show the rendered state of any open file (markdown, mockup, diagram). Use for visual verification.
- `get_session_edited_files` — list files edited this session (use before a commit proposal).
- `update_session_meta` — name, tags, phase for the **current** session only. Never use this to update a different session; use `update_session_board` instead.

### `mcp__nimbalyst-host` — settings, cross-session context, and orchestration (deferred)

- Settings: AI defaults, theme, completion sound, spellcheck, sync, extension enabled state, workspace trust — all settable via MCP.
- Cross-session context: `list_recent_sessions`, `get_session_summary` (read what another session did), `get_workstream_overview` / `get_workstream_edited_files`, `update_session_board` (change phase/tags on *another* session by ID), `schedule_wakeup`.
- Orchestrate other sessions: `spawn_session` / `create_session`, `send_prompt`, `get_session_status` / `get_session_result` / `list_spawned_sessions`, `respond_to_prompt`, `list_worktrees`. Used by any "spawn N parallel reviewers" pattern.

### `mcp__nimbalyst-trackers` — tracker tools (deferred, per-project opt-out)

- `tracker_*` CRUD plus tracker config (`tracker_set_sync_policy`, `tracker_set_issue_key_prefix`). The whole server is omitted when a project turns off **AI Agent Access** in tracker settings.

### `mcp__nimbalyst-situational` — mode-specific tooling (deferred)

- `voice_agent_speak` / `voice_agent_stop`, `readCollabDoc` / `applyCollabDocEdit`, `feedback_*`.

### `mcp__nimbalyst-<ext>` — extension tools (deferred, one server per extension)

- Each active extension contributes its own deferred server: `automations_*`, `homekit_*`, `social_*`, `reddit_*`, `twitter_*`, `slides_*`, `mindmap_*`, `excalidraw_*`, `threed_*`, `mockuplm_*`, `datamodellm_*`, `namenym_*`, etc.

### Other MCP servers

`mcp__linear`, `mcp__claude_ai_Gmail`, `mcp__claude_ai_Google_Calendar`, `mcp__claude_ai_Google_Drive`, `mcp__posthog` — external-service integrations. These come and go depending on what's connected.

---

## 3. Workflow layer

Reusable workflows that wrap a sequence of capability calls.

### Slash commands in `.claude/commands/`

Repo-local commands. Each is a markdown file with a YAML frontmatter (`name`, `description`) and the full workflow as prose.

Current set (grouped by purpose):

- **Investigation / planning:** `investigate`, `design`, `analyze-code`, `analyze-sessions`, `review-branch`, `review-contribution`, `review-multiple-contributions`, `triage-issues`, `pull-prs`, `roadmap`, `user-research`
- **Implementation:** `implement`, `track`, `mockup`, `tooltip`, `walkthrough`, `playwright`, `write-tests`, `refactor-claude-md`
- **Release & commit:** `commit`, `prepare-commit`, `push-and-release`, `release-alpha`, `release-extension`, `release-ios`, `ios-release`, `promote-public-release`
- **Maintenance:** `session-cleanup`, `mychanges`, `posthog-analysis`, `update-libs`, `restart`, `bug-report`, `social-response`, `e2e-devcontainer`

The pattern for a well-formed command: read-only by default, produce a structured report, use `PromptForUserInput` with `defaultChecked: true` items to collect approvals, apply only what the user kept checked. `session-cleanup` and `triage-issues` are good templates.

### Subagents (`Agent` tool with `subagent_type`)

- `Explore` — fast read-only search agent for "where is X defined?" / multi-location lookups. Use instead of running 5+ Glob/Grep calls yourself.
- `Plan` — software-architect agent for non-trivial implementation strategies.
- `e2e-runner` — runs Playwright in an isolated dev container (note: the user-level memory says **don't** use this for normal E2E work; run on the host instead).
- `general-purpose` — catch-all for multi-step research.

Subagents have separate context windows. Use them when (a) the work is genuinely independent and parallelizable, (b) the raw search output would otherwise blow your context, or (c) you want a second opinion without your prior analysis biasing it.

### The `/investigate` → `/design` → `/implement` arc

Conventional flow for non-trivial work:
1. `/investigate` — research the problem, identify root cause, sketch options without writing code
2. `/design` — produce a plan document in `nimbalyst-local/plans/`
3. `/implement` — execute the plan with progress tracking

The investigate→design handoff is direct (don't ask the user to re-invoke `/design` once they've said "design it"). See `feedback_investigate_to_design_handoff.md`.

---

## 4. Observability layer

What the agent can see about runtime state — without asking the user to copy-paste anything.

### Logs

- `get_main_process_logs` — Electron main process; covers IPC handlers, services, sync workers
- `get_renderer_debug_logs` — renderer console; covers React, Jotai, editor state, UI events

**Always read main.log after exercising any code path that runs inside a `try { … } catch { console.error }` block.** Silent-catch swallowing is the single most common reason a "fix" doesn't fix. See `feedback_grep_log_after_trycatch.md`.

### Database

- `database_query` (MCP) — read PGLite tables without process contention
- Never `node -e "const { PGlite } = require(...)"` or sqlite CLI — they corrupt the DB

For sync/collab bugs, **local PGLite ≠ server collab state.** `tracker_body_cache`, `documents`, etc. only reflect the local side. Server-side Y.Doc / DurableObject state lives in Cloudflare Workers and must be inspected via `wrangler tail` or wrangler-backed E2E tests. See `feedback_local_state_vs_server_state.md`.

### Runtime DOM / renderer state

- `renderer_eval` — evaluate arbitrary JS in the renderer for "what does the DOM look like right now?" / "what's in this atom?"

### Screenshots

- `capture_editor_screenshot` — inline-render any file the editor can open (markdown, Mermaid, Excalidraw, mockups, data models)
- Used for: verifying diagrams render, confirming UI mockups look right, showing the user what an architectural change looks like

### Network / Cloudflare workers

- `Bash` with `curl` (the agent runs it)
- `Bash` with `wrangler tail` — long-running, use `run_in_background`
- `Bash` with `gh` — GitHub issues, PRs, checks

### Sessions / kanban / git

- `list_recent_sessions`, `get_session_summary` — what happened in a prior session?
- `developer_git_log` (MCP) or `git log` via Bash
- `git status`, `git diff` via Bash — fine for read-only inspection

---

## 5. Verification layer

How the agent confirms a fix actually works before announcing it.

### Unit tests

- `npm run test:unit` (vitest)
- Per-package: `npm run test` inside the package
- iOS: `npm run ios:test:swift`

### E2E tests (Playwright on host)

- Spec files under `packages/electron/e2e/`
- Run with `npx playwright test <single-spec-file>` — **one file per command** (multiple files fight over the PGLite database lock)
- Use `--max-failures=1`, read the error, fix, run again — never run multiple times when you already have the failure
- The app is fast; tests use short timeouts (500–1000ms), not 5s
- No real AI calls in E2E; use the `aiToolSimulator.ts` to simulate AI behavior
- All 29 spec files must have `test.describe.configure({ mode: 'serial' })`

See [E2E_TESTING.md](./../docs/E2E_TESTING.md) and the patterns in `tracker-content-collab.spec.ts` / `tracker-sync-collab.spec.ts` (`RUN_COLLAB_TESTS=1`, `document-sync:open-test` IPC for Stytch bypass).

### Restart-to-verify (avoid where possible)

`restart_nimbalyst` is available, but **requires user permission** every time. It's a 30-second round-trip and a strong cost signal.

Per the end-to-end-verification rule: if a bug requires `/restart` to test, the **first** deliverable is a failing test that the fix must make pass — not a code change tried hopefully and a restart prompt to the user. Restart-to-verify is the last resort, not the default.

### Type checks

- `npm run typecheck` at the root
- Per-package `tsc --noEmit`
- Type checks verify correctness, not feature correctness; don't conflate "tsc passes" with "the user can do the thing."

### Linting

- `npm run lint` if present per package; ESLint config is workspace-wide

---

## 6. Coordination layer

How multiple sessions, workstreams, and agents work together.

### Sessions

Every AI conversation is a "session" with persistent metadata (name, tags, phase) and content. Sessions are listed on a kanban board.

Phases:
- `backlog` — captured, not started
- `planning` — exploring / designing
- `implementing` — actively writing code
- `validating` — work done, awaiting user verification
- `complete` — user has confirmed (only the user promotes a session to `complete`; agents never set this)

### Workstreams

A workstream groups multiple sessions working on the same problem (e.g. "Debug tracker description empty on load" had 5+ sessions). Use:
- `get_workstream_overview` to see the whole group
- `get_workstream_edited_files` to see what's been changed across all sessions

When spawning a sibling session for a related sub-task, link it to the same workstream so context flows.

### Multi-instance dev (for collab/sync testing)

- `npm run dev:user2` — second instance with isolated `NIMBALYST_USER_DATA_DIR`, port `5274`, `--outDir=out2`
- Worktrees auto-derive a per-worktree userData dir via `crystal-run.sh`

### Worktrees

For isolated agent sessions that need to make speculative changes without polluting the main checkout:
- Created via the "New Worktree" UI in the app
- Per-worktree dev instances use a per-worktree userData dir so PGLite locks don't collide
- Default: **don't** add worktrees on your own initiative — only when the user explicitly asks. See `feedback_no_unprompted_worktrees.md`.

### Meta-agent

The orchestration tools on `mcp__nimbalyst-host` let a session spawn and supervise other sessions. Used for:
- Parallel review of multiple PRs (`/review-multiple-contributions`)
- "Spawn a sibling to verify the fix end-to-end" (the tracker workstream pattern, when used correctly)
- Long-running background work with status check-ins

### Hand-off via session briefs

When spawning a sibling/child, include a thorough brief: parent session ID, what's already been done, files this session touched, hard rules (no restart, no commits), expected deliverables. The brief is the only thing the new session inherits — assume it has zero context otherwise.

---

## 7. Provenance & Tracking layer

How code changes, decisions, and ideas stay linked to the intent that produced them. This is the "institutional memory of why" — the layer that lets a contributor six months from now ask "where did this come from?" and actually get an answer.

Three things connect here: **file edits ↔ sessions ↔ tracker items**. Each link is bidirectional and navigable from the UI.

### File-edit tracking linked to sessions

Every file edit made inside an AI session is recorded with the session ID. The result is a richer version of `git blame`:

- **From the current session** — the Files Edited Sidebar lists exactly what this session has changed, with inline diffs. You always know your blast radius.
- **From any file** — open the file and see which sessions edited it (and when). Click through to jump back into that session's conversation. This is the part that makes the harness powerful long-term: you don't just see *what* changed, you see the back-and-forth that produced it.
- **From a workstream** — `get_workstream_edited_files` aggregates edits across every session in the workstream, so you can see the full footprint of a multi-session effort.
- **Cross-session conflict awareness** — when multiple sessions are touching adjacent files, the file-edit index makes the overlap visible (today: manually via git status; ideally: surfaced proactively — see Gaps below).

The point isn't "log who changed what" — git already does that. The point is "preserve the reasoning behind every change as a navigable artifact." A commit message captures the *what*; the linked session captures the *why and how we got there*.

### Session ↔ tracker linkage

A session can be linked to one or more tracker items via:
- `mcp__nimbalyst-trackers__tracker_link_session` — bind this session to a tracker
- `mcp__nimbalyst-trackers__tracker_unlink_session` — undo
- `mcp__nimbalyst-trackers__tracker_link_file` — bind a specific file to a tracker (e.g. "this bug lives in `TabEditor.tsx`")

The tracker carries the **intent** ("fix the F2 rename data-loss bug, reported by sd-std on Linux"); the session carries the **execution** (turn-by-turn conversation + edits + tests + commits). Both directions are searchable:
- **From a tracker** — see every session that worked on it, in order; replay the conversation that produced the fix.
- **From a session** — see which tracker items it was for; understand the upstream context (reporter, severity, related issues) the session was responding to.

This is what enables hand-offs across days, weeks, or contributors. A new session inheriting work on NIM-633 doesn't need an essay — it just reads the prior linked sessions in chronological order.

### Tracker item types

Tracker items are typed records that capture different kinds of intent. The default types:

- `bug` — defects, log them as you find them, **before** writing fix code (the rule: a bug tracker item exists for every bug fix). Lifecycle: `backlog` → `in-progress` → `in-review` → `done`.
- `feature` — feature ideas captured the moment you have them, without derailing current work. Feeds `/roadmap`.
- `decision` — architectural decisions, library choices, "we considered X and chose Y" with rationale. Searchable later when a future agent asks "why is this the way it is?". The rule: when choosing between alternatives, log a decision tracker.
- `plan` — multi-step plans for work in flight. Linked to a `nimbalyst-local/plans/*.md` doc that `/design` produces and `/implement` executes against.
- `incident` — operational incidents (Stytch JWKS rotation, sync outage, CI breakage). Captures timeline, blast radius, and follow-ups.
- `github-pr` — pulled-in PRs from upstream (`/pull-prs` populates this).

Custom types via `mcp__nimbalyst-trackers__tracker_define_type` if these don't fit your domain.

### Tracker tools

- `tracker_create` — new item with type, title, body, area, severity
- `tracker_update` — change fields, body, status (status changes trigger a "Tracker Updated" widget in the transcript)
- `tracker_get` — read a tracker by issue key (e.g. NIM-633)
- `tracker_list` — list/filter by type, status, area, tag
- `tracker_add_comment` — annotate progress without overwriting the body
- `tracker_link_session` / `tracker_unlink_session` / `tracker_link_file` — manage linkage
- `tracker_define_type` / `tracker_delete_type` — customize the schema

For body-heavy items (plans, decisions, incident reports), the body is a real collaborative document — same Lexical editor as everything else, syncs through CollabV3, supports embeds, images, and inline references.

### Tracker workflows

- **As-you-go bug logging:** see a bug, file it (`/track` or `tracker_create`) with a one-line title and the reproduction steps, set status `backlog`. Don't context-switch out of your current work to fix it — the tracker captures it for later.
- **Feature ideas:** same pattern. `/track` with type `feature`. They aggregate into the roadmap.
- **Decisions in flight:** when you're about to commit to library X over library Y, write a decision tracker with the alternatives and the rationale. Future you and future contributors will thank you.
- **Plans:** `/design` produces both a plan doc and a linked plan tracker. `/implement` executes against it and updates progress.
- **Incident postmortems:** during or after an outage, file an incident tracker. Link the sessions that diagnosed and fixed it.

See [TRACKER_WORKFLOWS.md](./../docs/TRACKER_WORKFLOWS.md) for the exact rule about bug trackers existing before fix code, and decision trackers on architectural choices.

### Use cases this layer unlocks

- **"Where did this code come from?"** — open the file, see the sessions that edited it, click through to the conversation that produced it.
- **"Why did we choose Y over X?"** — search decision trackers for the area; the rationale is right there.
- **"What was the user reporting when we changed this?"** — file → session → tracker → original bug report / GitHub issue / user message.
- **"What bugs are open in the editors area?"** — filter trackers by type=`bug` and area=`editors`. The kanban board view groups them by status.
- **"Build a roadmap from current ideas"** — `/roadmap` aggregates open feature trackers, groups by area, surfaces patterns.
- **"What did we ship last week?"** — `/mychanges` summarizes recent commits in standup format; cross-references trackers that were closed.
- **"Did this session touch the same files as that one?"** — get_workstream_edited_files + the per-file session list catch overlap before merge conflicts.

The harness gets exponentially more valuable as this data accumulates. After three months of consistent tracker hygiene, the answer to almost any "why is this the way it is" question is two clicks away.

---

## 8. Communication layer

How the agent shows results back to the user.

### Interactive prompts

- `mcp__nimbalyst__AskUserQuestion` — 1–3 multiple-choice questions for branching decisions
- `mcp__nimbalyst__PromptForUserInput` — richer structured input (multiSelect with subtitles, reorder, editText, confirm, singleSelect with allowOther)

When the next step is blocked on a user decision, use one of these instead of burying the question in chat. The widget is durable — survives navigation and restarts; chat questions don't.

See [INTERACTIVE_PROMPTS.md](./../docs/INTERACTIVE_PROMPTS.md) for the durable-prompt model.

### Inline visuals

- `display_to_user` — bar / line / pie / area / scatter charts, with optional error bars (95% CI). Always prefer over a markdown table for numeric data. Compute error bars with `awk`/`bc`/Python, not manually.
- `display_to_user` — also accepts images (local screenshots, generated images)
- `capture_editor_screenshot` — show rendered content of any open file

### Diagrams

- Mermaid (in `.md`) — flowcharts, sequences, structured diagrams
- Excalidraw (`.excalidraw`) — architecture, sketches, freeform spatial layouts
- MockupLM (`.mockup.html`) — UI mockups, wireframes
- DataModelLM (`.datamodel`) — database schemas, ERDs
- Mindmap (`.mindmap`) — idea brainstorming
- Slides (`.slides.md`) — presentations

For architectural decisions, create an Excalidraw in `nimbalyst-local/architecture/` and show it via `capture_editor_screenshot`. See [ARCHITECTURE_DIAGRAMS.md](./../docs/ARCHITECTURE_DIAGRAMS.md).

### Voice

- `voice_agent_speak` / `voice_agent_stop` — audio output for the voice mode flow

### Walkthroughs / help tooltips

Long-form help content uses the centralized registry in `HelpContent.ts` keyed by `data-testid`. See [HELP_WALKTHROUGHS.md](./../docs/HELP_WALKTHROUGHS.md).

---

## Improvement loop

The harness improves itself when the user runs `/analyze-sessions`. The command:

1. Pulls recent sessions (default: current session or current workstream)
2. Cross-references against `.claude/agent-mistakes.md`, `.claude/rules/`, and `MEMORY.md`
3. Surfaces three categories: repeated mistakes, speed losses, underused tools
4. Proposes targeted edits: append to mistakes log, new rule files, new memory entries, CLAUDE.md updates
5. Asks the user via `PromptForUserInput` which suggestions to apply
6. Applies the approved subset

This is how 2026-05-20's tracker-body workstream produced the `end-to-end-verification.md` rule, the `feedback_grep_log_after_trycatch.md` memory, the `feedback_local_state_vs_server_state.md` memory, and the CLAUDE.md "Always Run Your Own Observation Commands" critical-rules section — all in one pass.

Run `/analyze-sessions` after any frustrating session or after a major workstream concludes. The signal decays quickly; capture it while the user can still recall what went wrong.

---

## Where the gaps are

Things we don't have yet but probably should. Each is a candidate for a future harness investment.

### Verification gaps

- **Automated "first failing test" check.** End-to-end-verification is a rule, not an enforced gate. We could add a pre-commit hook that refuses to commit a bug-fix label without a test in the same diff that references the issue/tracker number.
- **Visual regression testing.** We use `capture_editor_screenshot` ad-hoc, but no automated pixel-diff suite for UI changes. The kanban board, transcript, and tracker detail views are all complex enough that a regression suite would have caught the autoscroll bug earlier.
- **Write-loop detection.** The 2026-05-20 "asd × 108 in 87 seconds" feedback loop went undetected because nothing throttles or logs document-write rates. A guard at the Y.Doc write boundary (warn if >N writes/second to the same key) would catch it.

### Observability gaps

- **Telemetry on agent behavior.** We capture user actions in PostHog but not "agent reached for tool X then tool Y" or "agent had to be corrected N times before convergence." A session-level metric of correction count and turn count would let us measure harness improvements rather than guess.
- **Mistake recurrence dashboard.** The agent-mistakes log is text; there's no chart of "git stash mistakes per month" or "feature-flag mistakes per month." Hard to know if a rule is actually working without that.
- **Context-window monitor.** Sessions silently degrade as they approach context limits; agents start summarizing prior work poorly. A visible indicator (the `display_to_user` chart capability already exists) would help users know when to spawn a sibling instead of continuing.

### Workflow gaps

- **Reviewer subagent before commit.** We have `/review-branch` and `/review-contribution`, but they're user-invoked. A "second opinion" subagent that runs automatically before `developer_git_commit_proposal` would catch a lot of the "I committed something that obviously violates rule X" pattern.
- **Uncertainty estimator.** The agent often "looks confident" while being wrong (the "fixed it!" pattern). A self-assessed confidence score per claim, or a forced "what evidence did you actually observe?" step before announcing a fix, might help.
- **Auto-replay failed sessions.** When a session ends with the user frustrated, we have no way to replay the same task against an improved harness to see if the new rule would have caught it. A replay harness (record turn-by-turn, swap out the model/rules, re-run) would let us validate rule changes.

### Coordination gaps

- **Cross-session knowledge graph.** Each session reads its own brief plus parent summary; there's no graph of "which sessions touched which files" beyond `get_workstream_edited_files`. A persistent index of (file → recent sessions) would help agents not stomp on in-flight work.
- **Better worktree affordances.** Worktrees are powerful but underused because creating one is a UI action. A `/worktree-this` command that captures the current uncommitted state into a fresh worktree would lower the bar.
- **Automatic conflict detection between concurrent sessions.** Multiple sessions can edit the same file. We rely on the user to notice via git status. The harness could detect overlap proactively and warn.

### Instructional gaps

- **Auto-promotion of agent-mistakes entries to rules.** Right now a mistake has to be manually promoted from `agent-mistakes.md` to `.claude/rules/` after `/analyze-sessions` flags it. A counter ("this kind of mistake has happened N times") could automate the suggestion threshold.
- **Stale-context detection.** Memory entries can rot (a referenced file gets renamed, a function gets removed). Nothing checks. A periodic linter that grep-validates the symbols mentioned in memory files would catch decay.
- **Onboarding doc for the harness itself.** This document is the start. A short "first 30 minutes" guide for a new contributor who's never seen the harness before would be useful.

---

## Adding to the harness

When you add a new piece of harness scaffolding, update this doc. The layered structure makes it obvious where a new entry goes:

- A new rule? Add to layer 1, then a one-line entry in the `.claude/rules/` list above.
- A new MCP tool? Add to layer 2 under the right server section.
- A new slash command? Add to layer 3.
- A new verification mechanism? Layer 5.
- A new way to coordinate sessions? Layer 6.
- A new tracker type or linkage between sessions/files/items? Layer 7.

Keep the entries terse — one line per item is the goal. The point is to have a complete index, not to re-document each thing in detail (link to its own doc instead).

---

## Related reading

- [CLAUDE.md](./../CLAUDE.md) — the agent's primary brief
- [EXTENSION_ARCHITECTURE.md](./../docs/EXTENSION_ARCHITECTURE.md) — how the product itself is built
- [E2E_TESTING.md](./../docs/E2E_TESTING.md) — verification layer details
- [DEBUGGING_LOGS.md](./../docs/DEBUGGING_LOGS.md) — observability layer details
- [INTERACTIVE_PROMPTS.md](./../docs/INTERACTIVE_PROMPTS.md) — communication layer details
- [INTERNAL_MCP_SERVERS.md](./../docs/INTERNAL_MCP_SERVERS.md) — capability layer details
- [AGENT_PERMISSIONS.md](./../docs/AGENT_PERMISSIONS.md) — the permission gate that sits in front of capability tools
- [agent-mistakes.md](./../.claude/agent-mistakes.md) — the running log of "what we learned the hard way"
