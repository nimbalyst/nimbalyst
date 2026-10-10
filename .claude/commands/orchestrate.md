---
description: Coordinate Nimbalyst sibling sessions with explicit model routing, file ownership, independent review, and run retrospectives.
---
# /orchestrate

Coordinate the requested work through Nimbalyst sibling sessions. Optimize for time to accepted output, including review, fixes, and integration. Keep the scope and authorization supplied by the user; orchestration does not itself authorize commits, deployments, restarts, or messages to people.

## Usage

- `/orchestrate <task or plan>` — implement or investigate the requested task with managed siblings.
- `/orchestrate retrospect <run or workstream>` — analyze an existing run and propose workflow or preference changes. Do not launch workers or apply those changes.
- `/orchestrate experiment <bounded task and models>` — compare implementations against the same brief and acceptance criteria, using separate artifacts. This mode authorizes only the specified comparison.

The text after the command is the task. When omitted, use an unambiguous task from the conversation; otherwise ask through Nimbalyst's interactive input tool. Do not interpret an investigation request as implementation approval.

This file is the canonical source. Nimbalyst exports it to provider skills; do not edit generated copies. Resolve the links below relative to `.claude/commands/orchestrate.md`, even when reading an exported skill.

## Preferences and run setup

Read the [local orchestration policy](../../nimbalyst-local/agent-policy/orchestration.md) if present. It is the single source for model choices, effort, and concurrency defaults. Current user instructions override it. If it is absent, use preferences explicitly supplied in the conversation; ask once for missing routing choices rather than inventing them. Do not silently substitute a model that is unavailable or change an existing session's model.

Read the governing plan and applicable repository instructions. For tracker-linked work, use `work_radar` when available, then link the session. For plan implementation, follow the progress conventions in [implement](implement.md), with the orchestrator owning the plan edits. Inspect `get_workstream_overview` and relevant active sessions before assigning work.

Keep a short run ledger at `nimbalyst-local/orchestration/<orchestrator-session-id>.md`, holding only what session tools cannot recover later:

- Task, plan, authorization, and starting revision.
- One row per slice: task ID, session ID, owned files, status.
- Findings that change the work: ID, owner, disposition.
- Human corrections, and gate/commit/deploy state per repository.

Do not record models, effort, timestamps, edited files, or message history; `get_workstream_overview`, `get_workstream_edited_files`, and the session database already have them. Update the ledger at milestones (launch, accepted handoff, gate, commit), not after every message, and keep it under about 100 lines. Re-read it after a context compaction. Only the orchestrator writes it.

## Decompose and launch

Follow the [parallel-session rules](../rules/parallel-sessions.md). Ownership includes tests, shared types, registries, barrels, manifests, generated artifacts, and docs. If two writers need the same file, sequence them as one slice. Reserve integration files for one named owner. The orchestrator may implement its own reserved slice, but must not edit a worker's files concurrently.

Establish one minimal real user journey before expanding a large batch: entry point, actual production callers, persistence/authority where relevant, and the result arriving at its intended user or agent. Give each transition an owner. A response component that is never mounted, or a notification pointing to an unavailable read API, is not a working journey.

Launch only disjoint, ready work that helps completion. Use the policy's concurrency limit as a starting point, not a quota; count active workers, not lifetime launches. Do not create another session for a trivial local action or spawn recursively without an agreed slice and ownership. Investigators may disprove the brief's suspected cause with evidence.

Use Nimbalyst `spawn_session`, not provider-native subagents as a substitute for visible managed siblings. Pass `model`, `effortLevel`, and `notifyOnComplete: true` explicitly. Omitted model uses the app default; omitted effort does not inherit; notifications default off. Discover the current tool schema and supported models rather than guessing aliases. Record effective settings when observable, including clamping. Do not set `isolated` for work that belongs in this workstream; inherit the working directory unless the user requests a separate worktree.

Each brief must be self-contained and include:

```text
Task ID / role / contract revision:
Orchestrator session ID / plan / relevant prior decisions:
Goal and observable acceptance:
Repository / owned files / forbidden files / dependencies:
Integration contract and current artifact revision:
Focused checks; no broad gate, commit, or changelog edits:
Report blockers or contract changes immediately. Otherwise finish with one
concise handoff: changed files, evidence, findings, remaining work, ownership.
Completion is delivered automatically; do not send a duplicate final prompt.
```

## Communicate and transfer ownership

Use `send_prompt` for actionable changes, blockers, decisions, or a request for work. Keep messages readable and concise; link detailed evidence. Do not send repeated status requests, FYIs to closed workers, or acknowledgement-only replies. An explicit follow-up to an idle worker starts another provider turn, even when it says “no further work.”

Automatic child updates report provider state, not accepted completion. Read every message in a delivered batch before acting; later reports can supersede earlier ones. Confirm current source before applying a stale handoff. Prefer completion notifications over polling; inspect status/result when making a dependency decision or resolving an actual stall.

On an ownership collision, stop affected edits. Before reassignment, get the old writer's terminal handoff and establish that its turn has settled, inspect current files, and record the new owner and revision. A sent stop message is not proof that editing has stopped. Use `interrupt: true` only when the old task is obsolete; interruption drives the existing FIFO queue and does not give the new prompt priority.

## Review, fix, and verify

Select independent reviewers using the model policy. A fresh session on the same model is independent context, not cross-model review. For a mixed-model batch, cover each model's authored portions with the opposite reviewer and explicitly review integrated seams. Give reviewers the requirements, exact artifact revision/diff, production paths, and test evidence, without dictating the desired verdict.

Reviewers report findings without opportunistic edits. Owners fix accepted findings; reviewers verify those changes against the finding IDs. Review stable revisions, or state what changed underneath a review and recheck affected conclusions. Do not relaunch a broad review merely to seek another green response. If successive fix cycles repeat the same blocker without reducing it, identify the failed assumption and escalate the strategy with concrete evidence.

Workers run focused behavioral checks. Once writers settle, the orchestrator runs the integrated gate once, including the packages and repositories actually affected. Rerun only when changes or failures require it; inspect saved failure output before repeating a suite. State gate coverage and exclusions: packages without a test/typecheck script were not verified. Respect repository-specific validation rules.

For risky persistence, authority, startup, or lifecycle changes, exercise real production callers and relevant transitions. Do not turn a failing first-open flow green by adding an extra mutation or other test-only workaround. Distinguish component tests, live runtime proof, human visual acceptance, and deployment. No amount of peer review substitutes for a missing acceptance check.

When a commit is requested, inspect the selected diff's dependency closure, including imports, exports, shared types, generated output, and registration. In a mixed checkout, validate the selected snapshot when those dependencies are in doubt; a green working tree can hide a broken commit. Coordinate missing dependencies with their owner instead of silently bundling unrelated work. Use Nimbalyst's commit proposal tool. Record commit and deployment status separately for every affected repository; an app commit cannot close a server-enforced criterion.

## Finish and learn

Summarize accepted behavior, unresolved findings, proof and its limits, and the exact ownership/repository state. Keep plan and session metadata honest; idle, handed off, reviewed, committed, and deployed are different facts. End settled workers without acknowledgement loops. Do not claim acceptance while awaiting a required human decision.

For a retrospective, read the ledger for scope and dispositions, and derive timings, models, and communication volume from Nimbalyst session tools and read-only database MCP queries; never open the live database directly. Report time to accepted output when recorded, provider-turn time and coverage, queue delay, communication volume, review/fix cycles, integration escapes, and human UX ratings. Separate human-origin prompts from agent notifications. Queue rows can be superseded/deleted; stored model selection can change; absent completion timing is unknown, not zero. Do not infer model speed from session age, task-agnostic medians, raw token totals, or unverified finding counts.

For an experiment, keep the task, starting artifact, constraints, and acceptance rubric comparable. Record model and effort per variant. Evaluate visual fit/usability with the human separately from correctness, accessibility, and code quality; use blind artifact selection when practical. Include review and rework in the outcome. Do not expand a bounded comparison into production implementation without authorization.

Close with a short, evidence-backed retrospective and proposed preference changes only when warranted. Use an interactive editable prompt before applying policy changes; never automatically rewrite the policy, this command, or persistent memory based on one run.
