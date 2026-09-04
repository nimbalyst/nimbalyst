---
name: triage-prs
description: Sync open GitHub PRs into the github-pr tracker, rank the untriaged ones for merge priority, and spawn /review-contribution sessions for the ones worth a deep look
---
# Triage Open GitHub PRs

Keep the `github-pr` tracker in sync with GitHub, then help me decide two things
for every PR that hasn't been looked at yet:

1. **Priority** — how important is this to merge, relative to everything else
   in the queue? (`low` / `medium` / `high` / `critical`)
2. **Is it worth a deep review right now**, or is it blocked (CI failing,
   conflicts, needs contributor changes) / clearly out of scope / too stale to
   bother with yet?

For the ones worth a deep review, let me pick a subset and spawn isolated
Nimbalyst sessions that run `/review-contribution <PR#>` against each — same
dispatch pattern as `/review-multiple-contributions`, throttled to N at a time.

This command does **not** do the deep review itself. It's triage: fast,
metadata-only (`gh pr view` / `gh pr checks`, no diffs), meant to answer "what
order should I work through this queue in," not "is this PR safe to merge."
That's `/review-contribution`'s job.

## Usage

`/triage-prs [using <model>] [max <N> at a time]`

Both are optional and only affect the spawn step in Step 6:

- `using <model>` — model for spawned `/review-contribution` sessions. Same
  resolution table as `/review-multiple-contributions` (`opus`, `sonnet`,
  `haiku`, `gpt-5`/`codex`, or a passthrough `provider:model` string). If
  omitted, spawned sessions inherit this session's model
  (`inheritModel: true`).
- `max <N> at a time` — concurrency for spawning, default **3**, clamp to
  `[1, 10]`.

## Steps

### 1. Fetch open PRs from GitHub

```bash
gh pr list \
  --state open \
  --limit 200 \
  --json number,title,url,author,headRefName,baseRefName,isDraft,createdAt,updatedAt
```

(`authorAssociation` is not a valid `--json` field on `gh pr list`/`gh pr view`;
get it per-PR via `gh api repos/{owner}/{repo}/pulls/<pr> --jq .author_association`
when needed in Step 3.)

Filter out PRs where `isDraft` is `true`.

### 2. Sync the tracker

Pull only the **non-terminal** items — the working set this command acts on.
`complete`/`rejected` items are already closed out and both sync steps below
explicitly leave them alone, so dumping every historical PR (the 500 cap is
mostly terminal) into context is pure token waste:

```
tracker_list({
  type: "github-pr",
  where: [
    { field: "status", op: "!=", value: "complete" },
    { field: "status", op: "!=", value: "rejected" }
  ],
  limit: 500
})
```

Dedupe on `prNumber`, not URL (URLs can shift if a fork is renamed).

Edge case: a PR that was previously merged/closed (terminal) and then
**reopened** on GitHub won't be in this filtered set, so it'll be re-created as
a fresh `backlog` item rather than reconciled in place — that's acceptable
(a reopened closed PR genuinely warrants fresh triage). Don't widen the filter
to catch it; the full-scan cost isn't worth that rare case.

- **Already tracked** → leave `status`, `priority`, and `notes` alone for now
  (they may already have maintainer-set values) — it gets re-evaluated in
  Step 4 only if `status` is still `backlog`.
- **Not tracked** → create it:

```
tracker_create({
  type: "github-pr",
  title: "<PR title>",
  fields: {
    prUrl: { url: "<pr url>", label: "#<number>" },
    prNumber: <number>,
    author: "<author.login>",
    headBranch: "<headRefName>",
    baseBranch: "<baseRefName>",
    status: "backlog"
  }
})
```

**Close the loop on merged/closed PRs.** For each tracked item whose `status`
is not yet `complete` or `rejected` and whose `prNumber` is **not** in the
open-PR list from Step 1, check what happened on GitHub:

```bash
gh pr view <prNumber> --json state,mergedAt,closedAt,title
```

(If an old item is missing `prNumber`, find it with
`gh pr list --state all --search "<distinctive title words>" --json number,state,mergedAt,title`.)

Then update the tracker so the board reflects reality:

- `state: MERGED` → `tracker_update` with `status: "complete"` and a note like
  `"Merged on GitHub <mergedAt date>."` (prepend it; keep any useful prior
  review note in parentheses). Backfill `prUrl`/`prNumber` if they were missing.
- `state: CLOSED` (not merged) → `status: "rejected"` with
  `"Closed on GitHub <closedAt date> without merge."`
- Still `OPEN` (e.g. it was just past the `--limit`, or re-opened) → leave it
  alone.

Surface every item updated this way in the report (Step 5).

This command only **creates** tracker items during sync — it never deletes.
Review-verdict status transitions (`inspecting` → `needs-review`/`safe`) are
owned by `/review-contribution` and the maintainer. The **only** `status`
writes this command makes are the merged/closed reconciliations above, which
mirror GitHub facts rather than making a judgment call.

### 3. Gather triage signals for untriaged PRs

"Untriaged" = tracker items with `status: backlog` (new ones from Step 2, plus
any left over from a previous run that never got reviewed).

For each untriaged PR, in parallel:

```bash
gh pr view <pr> --json number,title,author,authorAssociation,body,additions,deletions,changedFiles,files,labels,createdAt,updatedAt,mergeable,mergeStateStatus,reviewDecision,isCrossRepository
gh pr checks <pr>
```

Do **not** run `gh pr diff` or read file contents — this is a metadata-only
pass. Derive, per PR:

- **Age** — days since `createdAt`, and days since `updatedAt` (staleness).
- **Size** — XS (<20 lines) / S (<100) / M (<400) / L (<1000) / XL (1000+),
  from `additions + deletions`.
- **Sensitive-area touch** — does `files[].path` match auth, sync/collab,
  IPC/main-process, persistence/DB, or other areas called out as
  high-blast-radius in `CLAUDE.md`? Flag if so — informs priority and whether
  it needs `/review-contribution`'s deeper analysis rather than a quick
  maintainer glance.
- **CI status** — passing / failing / pending / no checks, from `gh pr checks`.
- **Mergeability** — `mergeable` / conflicting / unknown, from
  `mergeStateStatus`.
- **Contributor signal** — `authorAssociation` (first-time / contributor /
  member / owner) — informs how much scrutiny to expect, not a merge blocker
  by itself.

### 4. Classify and rank

For every untriaged PR, decide:

- **Priority** — `low` / `medium` / `high` / `critical`:
  - `critical` — fixes a known fix-now bug, security issue, or blocks a
    release; trivial-and-cheap wins that unblock other work also qualify.
  - `high` — solid, well-scoped contribution; CI green; no conflicts.
  - `medium` — reasonable contribution, standard queue position.
  - `low` — nice-to-have, large/sprawling diff, touches a frozen area, or
    thin on justification.
- **Blocked** (separate from priority — a `high` priority PR can still be
  blocked): CI failing, merge conflicts, or the PR body/commits signal WIP.
  Note *why* — this is what should get fixed before anyone spends review time
  on it.
- **Staleness flag** — no activity in 14+ days. Doesn't lower priority by
  itself, but worth a nudge-comment candidate rather than immediate review.
- **Recommend for deep review** — yes/no. No if blocked, clearly out of scope,
  or trivially a duplicate of another open PR touching the same lines. Yes
  otherwise — including `low` priority ones, since "worth reviewing
  eventually" and "urgent" are different axes.
- **Rationale** — one short sentence, written for the `notes` field and the
  report.

### 5. Report

Print the queue ordered by priority tier (`critical` → `high` → `medium` →
`low`), and within a tier, smaller diffs before larger ones, then oldest
first. Blocked PRs stay in their priority tier but are marked clearly so they
don't get spawned for review by mistake.

```
## critical (N)
- #412 "Fix crash on empty tracker sync" — S, CI passing, mergeable
    @firsttime-contrib (first-time). Why: fixes a fix-now-bucket crash, small diff.
    Recommend: deep review.

## high (N)
- #405 "Add dark mode toggle persistence" — M, CI passing, mergeable
    @regular-contrib (contributor). Why: clean scoped feature, no conflicts.
    Recommend: deep review.
- #398 "Refactor IPC listener registration" — L, CI failing (lint), conflicts
    @regular-contrib. Why: touches ipc-listeners.md's central-registration
    pattern — high value if it lands clean.
    BLOCKED: CI failing + merge conflicts. Recommend: comment asking for a
    rebase + fix before review.

## medium (N)
...

## low (N)
...

## reconciled with GitHub (merged/closed externally) (N)
- #380 "..." — was: inspecting → complete (merged on GitHub 2026-07-01).
- #362 "..." — was: backlog → rejected (closed on GitHub 2026-06-15 without merge).
```

End with a one-line summary:
`Triaged N PRs (M newly synced): X critical, Y high, Z medium, W low, B blocked, R reconciled (merged/closed).`

### 6. Write priority + rationale back to the tracker

For every untriaged PR classified in Step 4, update its tracker item with the
priority and a one-line rationale. This is the only tracker write this
command makes beyond Step 2 (creating new items and reconciling merged/closed
ones) — it never sets a review-verdict `status`.

```
tracker_update({ id: "<item id>", fields: {
  priority: "<low|medium|high|critical>",
  notes: "<one-line rationale, including BLOCKED: <reason> if applicable>",
  prUrl: { url: "<pr url>", label: "#<number>" },
  prNumber: <number>
}})
```

`prUrl` (and `prNumber`) must be passed through on every update — the schema
requires `prUrl` even when only `priority`/`notes` are changing.

### 7. Confirm the spawn plan via PromptForUserInput

This command is read-only toward GitHub itself (no comments, no status
changes on PRs). Do not spawn any review sessions until I confirm.

Use `mcp__nimbalyst-mcp__PromptForUserInput` with:

- **multiSelect field** — one row per PR recommended for deep review in Step
  4, ordered the same way as the report (priority tier, then size, then age).
  Pre-check everything that is `critical`/`high` priority and not blocked.
  Leave `medium`/`low` priority rows unchecked by default. Never pre-check a
  blocked row. Example rows:
  - "Spawn /review-contribution for #412 Fix crash on empty tracker sync (critical)" (pre-checked)
  - "Spawn /review-contribution for #405 Add dark mode toggle persistence (high)" (pre-checked)
  - "Spawn /review-contribution for #420 Add CSV export (medium)"
  - "Spawn /review-contribution for #398 Refactor IPC listener registration (high, BLOCKED — CI failing)" (unchecked, since it's blocked)

Do NOT fall back to listing the plan in chat and waiting for a reply. The
prompt is the confirmation step.

### 8. Spawn confirmed reviews (throttled dispatch)

For every PR the user selected, dispatch the same way
`/review-multiple-contributions` does — this command does not review PRs
itself, it delegates to isolated sessions running `/review-contribution`.

1. Launch up to `concurrency` (from Step "Usage", default 3) sessions
   immediately via `mcp__nimbalyst-meta-agent__spawn_session`:
   - `prompt`: exactly `/review-contribution <PR#>` — nothing else. No
     preamble, no "please run", no natural-language description of the
     command.
   - `title`: `"Review PR <#> - <pr title>"`.
   - `isolated`: `true` — each review is a top-level session, not parented
     under this triage session.
   - `notifyOnComplete`: `true`.
   - `model`: the resolved model from Step "Usage", or omit + set
     `inheritModel: true` if none was given.
2. On each completion notification, call
   `mcp__nimbalyst-meta-agent__list_spawned_sessions`, move newly-terminal
   sessions out of in-flight, and spawn the next queued PR while
   `in-flight.length < concurrency`.
3. When the queue is empty and nothing is in-flight, fetch
   `mcp__nimbalyst-meta-agent__get_session_result` for each spawned session
   and print a summary table (PR / title / priority / verdict / blockers /
   session id) — same shape as `/review-multiple-contributions`'s summary.

`/review-contribution` owns the tracker's `status` transitions
(`inspecting` on start, `safe`/`needs-review` on verdict) for each PR it
reviews, and links its own spawned session to the `github-pr` item so the
board cross-references the review — this command does not duplicate either.

## What NOT to do

- Do not comment on, approve, close, or merge any PR.
- Do not run `gh pr checkout`, `git fetch`, or any command that touches the
  working directory — this command and its spawned reviews are metadata/API
  only (`/review-contribution` has its own stricter no-touch rules).
- Do not set a review-verdict `status` (`inspecting`/`needs-review`/`safe`) on
  a tracker item — that's `/review-contribution`'s and the maintainer's call.
  The sole exception is Step 2's reconciliation: `complete`/`rejected` when
  GitHub says the PR was merged/closed.
- Do not auto-close or auto-reject a PR, even one that looks clearly
  out-of-scope. Flag it in the report and let the maintainer decide.
- Do not spawn review sessions the user didn't check in the confirmation
  prompt.
- Do not re-triage (overwrite `priority`/`notes`) on a PR whose `status` has
  moved past `backlog` — once it's `inspecting` or later, priority ranking no
  longer matters; leave those fields alone.

## Notes

- The `github-pr` tracker schema lives at `.nimbalyst/trackers/github-pr.yaml`.
  If it's not loaded, the user may need to switch workspaces or reload.
- This replaces the old `/pull-prs` command — the GitHub sync step (Step 2)
  covers everything `/pull-prs` used to do.
- Pair this with `/review-contribution <PR#>` for a one-off deep review
  outside the triage flow, or `/review-multiple-contributions` to batch-review
  a specific PR list without the triage/ranking step.
