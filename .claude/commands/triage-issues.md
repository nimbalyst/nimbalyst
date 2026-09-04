---
name: triage-issues
description: Fetch recent GitHub issues from nimbalyst/nimbalyst and triage them by importance, duplicates, and already-fixed status — then optionally spawn /investigate sessions for the critical ones
---
# Triage Recent GitHub Issues

Pull the most recent GitHub issues from `nimbalyst/nimbalyst` and help me decide:
1. Is it a **bug** or a **feature**, and does it have the right **type** (not label — GitHub issue type)?
2. Is it a **duplicate** of an existing issue or tracker bug?
3. Has it **already been fixed** (recent PR / recent session)?
4. How urgent is it — **fix-now / fix-soon / fix-later / needs-info / not-a-bug**?
5. For the critical ones, let me pick a subset and spawn isolated Nimbalyst sessions that run `/investigate` against each.

**I do not care about labels.** Do not propose `area:*`, `status:needs-triage`, `status:accepted`, or any other label edits. If a label is obviously wrong and blocking triage clarity, mention it once — but don't make label management part of the action plan.

## Usage

Arguments: `<time-period>` (optional, default `1d`)
- `1d` = last 24 hours
- `2d`, `3d`, `1w`, etc.

## Steps

### 1. Fetch recent issues

Convert the time period to an ISO date and query GitHub. Open issues only.

```bash
SINCE=$(date -v-1d -u +"%Y-%m-%dT%H:%M:%SZ")   # adjust -1d per argument

gh issue list \
  --repo nimbalyst/nimbalyst \
  --state open \
  --limit 100 \
  --search "created:>=${SINCE}" \
  --json number,title,url,author,createdAt,labels,body,comments,issueType
```

Sort newest-first. If zero results, say so and stop.


### 2. Gather context for dedupe and already-fixed detection

Pull three sources in parallel:

**(a) Local bug backlog** — for internal awareness only:
```
tracker_list({ type: "bug", limit: 200 })
```
The tracker is **private**. Use it to recognize that an issue is already known internally (and to inform severity/bucket), but **never** mark a public GitHub issue as a duplicate of a `NIM-#` tracker item — the reporter can't see it. A tracker match means the bucket is `fix-soon`/`fix-now` with a note that it's tracked internally, not `duplicate`. Only another **open public GitHub issue** is a valid duplicate target.

**(b) Recent AI sessions** — for already-investigated work:
```
mcp__nimbalyst-session-context__list_recent_sessions({ limit: 100 })
```

Scan session names/tags/summaries for `#NNN` references, matching titles, or matching symptoms. If a session covers it, note that and don't propose new investigation. If a session looks plausibly related but it's not obvious, call `get_session_summary({ sessionId })` for a closer look.

**(c) Open + recently-merged PRs** — for already-fixed / in-flight work:
```bash
# Pull recent merged PRs once (last ~2 weeks) and grep locally:
gh pr list --repo nimbalyst/nimbalyst --state merged --limit 50 \
  --json number,title,url,body,mergedAt,headRefName

# And open PRs:
gh pr list --repo nimbalyst/nimbalyst --state open --limit 50 \
  --json number,title,url,body,isDraft,author,headRefName
```

For each candidate issue, match by `#NNN`, by title keywords, by referenced files in the PR body, and by symptom. If a PR is open/draft, the issue is **in-flight** — don't propose investigation. If a PR is merged, the issue is likely **already-fixed** — propose closing with a pointer to the PR.

### 3. Classify each issue

For every issue, decide:

- **Type correction** — what does GitHub's `issueType` currently say, and is it right? A bug filed as a Feature (or vice versa) gets flagged for type correction. The intake template gets this wrong constantly.

- **Bucket** — one of:
  - `fix-now` — crash, data loss, regression, blocks core flow, broken on common platforms, or trivial-and-cheap
  - `fix-soon` — meaningful bug or papercut, not blocking, fits current focus
  - `fix-later` — nice-to-have, edge case, low-traffic surface
  - `already-fixed` — a merged PR fixes this; just needs closing
  - `in-flight` — an open/draft PR is fixing this; just needs review/landing
  - `needs-info` — repro unclear, missing version/platform, or contradictory
  - `duplicate` — matches **another open public GitHub issue** (never a private `NIM-#` tracker item)
  - `feature-request` — not a bug; route to roadmap
  - `not-a-bug` — out of scope, by-design, or contradicts a prior decision

- **Severity** — critical / high / medium / low. Use judgment — a low-severity bug can still be `fix-now` if it's a one-line change. A high-severity bug can still be `fix-later` if the area is frozen.

- **Why** — one short sentence on why this bucket. This is the line I'll read when deciding what to work on.

- **Linked PR** — if found in step 2, surface it: `PR #MMM (open/draft/merged) "<title>"`.

- **Linked session** — if found in step 2, surface it: `session "<name>" (sessionId)`.

- **Duplicate target** — if `duplicate`, name the canonical **public** issue: `duplicates #MMM`. Never close a public issue against a private `NIM-#` tracker item. If the only match is a private tracker item, the issue is **not** a duplicate — bucket it normally and add a `(tracked internally as NIM-XYZ)` note for your own reference only.

### 4. Output report

Print a single triage report. Group by bucket, newest first within each bucket. Lead each line with the issue number, title, current type, and severity:

```
## fix-now (N)
- #376 "ScheduleWakeup payload rendered as user message" [type: Bug] — high
    Why: visible transcript corruption, affects every Claude Code session.
    PR: #410 (open) "fix: render ScheduleWakeup as tool call" — review, don't reinvestigate.
    Session: none.

## already-fixed (N)
- #371 "Sync hangs on large tracker bodies" [type: Bug] — high
    Fixed by PR #408 (merged 2026-05-29). Close with pointer.

## in-flight (N)
- #374 "Respect CLAUDE_CODE_AUTO_COMPACT_WINDOW" [type: Feature → should be Bug]
    PR: #412 (draft) — wait for landing. Also: type is wrong, propose correction.

## fix-soon (N)
- #380 "..." [type: Bug] — medium
    Why: ...

## fix-later (N)
- #372 "Search in source mode doesn't scroll to match" [type: Bug] — low

## feature-request (N)
- #373 "Back/Forward navigation history" [type: Feature]
    Route to /roadmap.

## needs-info (N)
- #381 "App crashes sometimes" [type: Bug]
    Missing OS, version, repro steps.

## duplicate (N)
- #379 "Tracker body empty after restart" [type: Bug] — duplicates #354
    Same symptom, same area. Close with pointer to the public issue #354.
    (Duplicate targets are always public GitHub issues, never NIM-# tracker items.)

## not-a-bug (N)
- #382 "..." [type: Bug → should be Feature or close]
    Why: ...

## type-corrections-only (N)
- #383 "Add dark mode toggle" [type: Bug → should be Feature]
    Otherwise no action needed beyond fixing the type.
```

End with a one-line summary:
`Triaged N issues from the last <period>: X fix-now, Y already-fixed, Z in-flight, ...`

### 5. Confirm action plan via PromptForUserInput

This command is read-only by default. Do not change types, close issues, post comments, or spawn sessions until I confirm.

After the report, draft a concrete action plan and surface it via `mcp__nimbalyst-mcp__PromptForUserInput`. Pre-fill so I can submit without retyping.

Build the prompt with these field types:

(a) multiSelect field — actions on individual issues. One row per proposed action. Examples:
- "Correct type on #383: Bug → Feature" (pre-checked)
- "Correct type on #374: Feature → Bug" (pre-checked)
- "Close #371 as already-fixed by PR #408 (with comment)" (pre-checked)
- "Close #379 as duplicate of #354 (with comment)" (pre-checked)
- "Post needs-info comment on #381" (pre-checked)
- "Close #382 as not-a-bug (with comment)" (pre-checked)

- "Spawn /investigate session for #376 ScheduleWakeup payload"
- "Spawn /investigate session for #380 ..."

**(c) optional `editText` fields** — for any duplicate-close, already-fixed-close, or needs-info comment where the standard template doesn't fit, seed `initialText` with a draft I can edit in place.

Do NOT fall back to listing the plan in chat and waiting for a reply. The prompt is the confirmation step.

### 6. Execute the confirmed actions


**Type corrections** — use the GitHub issue type API:
```bash
gh issue edit NNN --repo nimbalyst/nimbalyst --type "Feature"
# or --type "Bug" / "Task"
```
If `gh issue edit --type` is unavailable in the installed version, fall back to the GraphQL mutation `updateIssueIssueType` via `gh api graphql`.

**Closes (already-fixed / duplicate / not-a-bug)** — comment first, then close with the right reason:
```bash
# Already-fixed:
gh issue comment NNN --repo nimbalyst/nimbalyst \
  --body "Fixed by #MMM (merged on YYYY-MM-DD). Closing — please reopen if you can still reproduce on the next release."
gh issue close NNN --repo nimbalyst/nimbalyst --reason "completed"

# Duplicate:
gh issue comment NNN --repo nimbalyst/nimbalyst \
  --body "Closing as duplicate of #MMM. Please continue the discussion there."
gh issue close NNN --repo nimbalyst/nimbalyst --reason "duplicate"

# Not-a-bug / wontfix:
gh issue comment NNN --repo nimbalyst/nimbalyst --body "<reason>"
gh issue close NNN --repo nimbalyst/nimbalyst --reason "not planned"
```

Do not add a `status:duplicate` (or any) label — the close reason carries the meaning.

**Needs-info comments** — post the seeded comment with `gh issue comment`. Leave the issue open.

**Spawn /investigate sessions** — for each selected investigation candidate, use `mcp__nimbalyst-meta-agent__spawn_session` to launch an isolated session. One per issue, in parallel (single message with multiple tool calls).

**(b) `multiSelect` field — investigation candidates.** List every `fix-now` and `fix-soon` issue that doesn't already have a linked PR or session. Default to unchecked — I'll pick the ones I want investigated. Example rows:
Session config:
- `title`: `#<issue#> <short-description> investigation` — must start with the GitHub issue number, trim leading `[Bug]` / `[Feature]` prefixes, and keep the descriptive part to 3-6 words.
- `prompt`: pre-loaded with the issue context and an `/investigate` invocation. Format:
```
  /investigate

  GitHub issue: https://github.com/nimbalyst/nimbalyst/issues/<NNN>

  Title: <title>
  Reporter: @<author>
  Type: <type>

  Body:
  <issue body>

  Investigate the bug, identify the root cause, and propose a fix.
  Name the session "#<NNN> <short-description> investigation" and preserve the issue number in the session title.
  Do NOT implement yet — wait for authorization.
```
- `isolated`: `true`. Each issue is its own top-level session, not a sibling in the triage workstream.
- Do NOT pass `useWorktree: true` unless I explicitly asked for worktrees. Sessions run in the current working directory.

Rationale: each issue is an isolated problem and should be fixed and committed separately, so do not group investigation children under the triage workstream.

After I submit:
After spawning, print the list of spawned session IDs + names so I can jump to them.

### 7. What NOT to do

Note the `issueType` field — that's the GitHub-native **type** (Bug / Feature / Task). This is what we care about, NOT labels.
- Do not propose `area:*` label edits. Ever.
- Do not propose `status:*` label edits. Ever.
- Do not apply `status:accepted` — that's a roadmap decision, maintainer-only, and we're not doing labels anyway.
- Do not propose label cleanup as a side action.
- Do not commit anything.
- Do not start implementing fixes — `/investigate` is the entry point for spawned sessions, and it stops before implementation.
- Do not run `npm run dev`.
- Do not spawn sessions for issues that already have an open/draft PR or a recent session covering them.
- Do not close or label a public GitHub issue as a duplicate of a private `NIM-#` tracker item. The reporter can't see the tracker, so the close would be meaningless. Public-issue duplicates must point at another public GitHub issue.

## Notes

- "Last day" means literal 24 hours by `createdAt`, not the GitHub day boundary.
- If an issue is from greghinkle (me), still triage it.
- If the issue body is thin, the issue goes in `needs-info` — do not guess repros.
- If you're unsure whether something is a bug or a feature, treat it as a feature (don't push it into the bug fix pipeline).
- See `feedback_github_issue_intake.md` and `feedback_close_duplicate_reason.md` in memory for the close/intake conventions.
