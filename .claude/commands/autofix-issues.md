---
name: autofix-issues
description: Survey recently triaged GitHub issues, propose the ones safe to fix without a product decision, and fan the selected ones out to independent sessions.
---

# /autofix-issues Command

Survey the issues triaged over a recent window and split them two ways: the ones that can be fixed without a decision from the user, offered as a checklist to fan out to independent sessions, and the ones that need the user's attention, with the reason for each.

Both lists are the deliverable. The second is not a leftover pile — it is where the user finds the decisions waiting on them.

```
/autofix-issues [timeframe]
```

Timeframe defaults to the last two weeks. Examples: `/autofix-issues`, `/autofix-issues 1w`, `/autofix-issues 30d`.

The user picks from a checklist. Never launch anything before they have chosen.

## Step 1: Gather candidates

Start by reading the last two or three entries in `nimbalyst-local/autofix-log.md`. Past runs record which screening calls turned out wrong; a mistake logged there twice should be applied as a criterion here rather than repeated.

Triage has already done the investigation — do not redo it. Pull from both sides and join them:

- **Tracker overlays**: `tracker_list({ type: "github-issue", full: true })`. The `notes` field carries the confirmed root cause with file:line anchors. This is the highest-value input; an issue with a confirmed root cause in `notes` is a candidate, one without is usually not.
- **GitHub**: `gh issue list --state open --json number,title,labels,updatedAt,comments` filtered to the timeframe. An issue that carries an `area:*` label and no longer carries `status:needs-triage` has been through triage.

Read the triage comment on each candidate. It states what was confirmed and what was left open — both matter for screening.

## Step 2: Screen for "safe to fix unattended"

Two independent bars. **A candidate must clear both.**

### Bar 1: no decision belongs to the user

Include when the correct behavior is already settled — a stated contract, an in-repo precedent, or an obviously-wrong result nobody would defend.

Exclude when shipping the fix would decide something on the user's behalf:

- A business or partnership question (vendor integrations, licensing, pricing)
- New UI surface, placement, naming, or an added setting or option. A gutter icon, nav entry, or content mode is never auto-fixable
- Default behavior changes that alter what existing users see
- Anything with two defensible designs and no precedent to break the tie
- Overlay status `needs-design`, `waiting-on-reporter`, or `declined`

When an issue is **partly** decidable, split it. #1422 was a genuine bug (custom types rendered a blank Type column, no defensible reading) bundled with a request for a new display option (a real product choice). The bug half is auto-fixable; the option half is not. Propose the half that clears the bar and say plainly what you left out.

### Bar 2: cheap and honest to validate with a unit test

Include when a vitest test can express the bug and flip red to green: pure logic, a parser, a comparison, a formatter, an event-handler condition, a reducer.

Exclude when the test would be theatre or absent:

- Verification needs a restart, a real window, or a manual UI pass. See [end-to-end-verification.md](../rules/end-to-end-verification.md)
- E2E-only. Those runs take over the user's desktop and are never fanned out
- The honest test would be presentation-only — icon names, exact strings, element counts. See the testing rules in [CLAUDE.md](../../CLAUDE.md)

### Hard exclusions, regardless of how small the diff looks

Do not fan these out even with a confirmed root cause. They need a human watching:

- **Anything that re-keys or migrates persisted state.** #1419 looked like a two-line path-normalization fix and was actually a change to the key under which permissions are stored — a naive fix would have silently unbound every symlinked workspace. See [destructive-data-paths.md](../rules/destructive-data-paths.md)
- Sync, collab, encryption, auth, or the personal/team JWT split
- Main-process initialization order
- Database schema or migrations
- Anything touching a file over ~2000 lines, where a slice is likely to grow it

## Step 3: Map files, then resolve conflicts

For each surviving candidate, list the files it will touch — source *and* tests. Then check the sets against each other.

**Overlapping candidates are one session, not two.** Merge them into a single slice with both issue numbers, or drop the weaker one. Never launch two sessions that touch the same file.

Check the shared files a source-only comparison misses: `CHANGELOG.md`, `package.json`, barrels and `index.ts`, central registries such as `KeyboardShortcutsDialog.tsx`, shared type modules. If a candidate needs one, it owns that file for the batch. See [parallel-sessions.md](../rules/parallel-sessions.md).

`CHANGELOG.md` is always orchestrator-owned. No slice ever touches it.

## Step 4: Present the checklist

Use `mcp__nimbalyst__PromptForUserInput` with a `multiSelect` field. One item per candidate:

- **title**: `#1424 — comma in a tracker title splits a relationship pill into two`
- **subtitle**: the fix in one clause, plus the files it will touch
- **defaultChecked**: true only for candidates with a confirmed root cause and an obvious test

Do not pad the list to look productive. Four solid candidates beat nine speculative ones — every weak slice costs a review cycle.

### The second list: needs your attention

Every screened-out issue goes into a second list, presented alongside the checklist. This is not an appendix — an issue correctly refused, with the reason, is worth as much as one fixed, and it is the only place the user learns a decision is waiting on them.

Group by **why it was excluded**, most actionable first:

1. **Waiting on a decision from you** — the highest-value group. State the decision itself, not just the issue title, so it can be answered in one line. "A vendor proposes their provider integration bundled with a 5 percent revenue-share partner program; accept, decline, or accept without the program?" beats "needs a product call."
2. **Partly automatable** — the decidable half is on the checklist, this names the half that is not, and why. Cross-reference the checklist item.
3. **Excluded by a hard exclusion** — persisted-state re-keying, sync, auth, migrations, main-process init. Say which one and in one clause why it needs a human watching, since these often look small.
4. **Not cheaply testable** — restart-to-verify, E2E-only, or the honest test would be presentation-only. Worth fixing, wrong shape for unattended work.
5. **Blocked on the reporter** — unconfirmed repro or an unanswered question. Note what was asked and when, so a stale one can be closed.

For each, give the issue number and title, the one-line reason, and the confirmed root cause if triage found one — a `needs-design` item with a known root cause is much closer to ready than one without.

Keep it scannable. One or two lines per issue, no restated triage comments.

## Step 5: Launch the selected slices

Concurrency caps at **4 child sessions in flight**. Queue beyond that and launch as slots free.

Use `spawn_session` as siblings in the current workstream. Do not pass `useWorktree` — never create worktrees unless the user asked.

Each brief must be self-contained. A slice that has to re-investigate has already lost the value triage created:

- The confirmed root cause with file:line anchors, and an explicit "do not re-investigate"
- The in-repo precedent to follow, when one exists
- The exact files this slice owns, and that siblings are live in the same checkout
- Never whole-file `Write` on a file it did not create
- Failing test first, then the fix. Extend an existing test file where one fits
- Run **only** its own targeted vitest file. Never `npm run typecheck` or `npm run test:prepush` — concurrent full runs produce false failures
- Never touch `CHANGELOG.md`
- Commit only its own files, with `Fixes #<issue>`. If its targeted test does not pass, do not commit — report back instead
- Its tracker overlay id, to link the session and set status
- Any hazard specific to that slice, stated as a constraint rather than left implied

## Step 6: Drive it to done

1. Wait for the slices. Do not poll in a tight loop; you are notified as each finishes.
2. Read what each one reports. A slice that declined to commit is a result, not a failure — surface its reasoning.
3. Run the gate **once** for the whole batch: `npm run typecheck && npm run test:prepush`. Check the reported failure counts, not just the exit code — `test:prepush` has exited 0 with a failing test.
4. On failure, send the failure back to the slice that owns those files. Do not hand-patch another session's work when that session still has the context.
5. Write `CHANGELOG.md` yourself, one bullet per user-visible fix, and commit it. Internal-only changes get no entry.
6. Append a run section to `nimbalyst-local/autofix-log.md` (see below).
7. Report: what landed, what did not and why, and what still needs the user. Do not push — pushing is the user's call.

## Step 7: Log the run

Append a section to `nimbalyst-local/autofix-log.md` — gitignored and local-only, never committed and never referenced anywhere that leaves this machine.

The log exists to refine the screening criteria, so its value is entirely in the honest entries. Record:

- One row per slice: issue, the fix in a clause, an outcome of `clean`, `rework`, `should not have shipped`, `withdrawn`, or `blocked`, and the commit it landed in
- **What went wrong**, in enough detail to act on. A slice that needed a round trip should say what it got wrong and what caught it — the gate, a sibling, or the user
- **Screening calibration**: how many were fanned out, how many were clean, and whether any candidate should have been held back. If a screening call was wrong, say which bar or exclusion would have caught it
- Any rule or command change the run produced

A batch written up as uniformly successful teaches nothing and is usually inaccurate. Prefer the ugly detail. Before screening a new batch, read the last two or three entries — a mistake that has already been logged twice belongs in the criteria, not in the log a third time.

### Link issues and commits

The log is read months later, so bare numbers are dead ends. Derive the repo slug once — `git remote get-url origin`, strip `git@github.com:` or `https://github.com/` and the trailing `.git` — then link every reference:

- **Issues**: `[#1424](https://github.com/<slug>/issues/1424)`. Link them in the table *and* in the prose, on first mention in each paragraph. Do not link a number that is not an issue, such as a version or a line number
- **Commits**: `[eda215570](https://github.com/<slug>/commit/eda215570)`, short hash in both label and URL. Get it from the slice's report or `git log`, never by guessing

Two cases worth a sentence in the entry rather than leaving a reader to puzzle them out:

- Two issues sharing one commit — say why, or it reads as a mistake
- A commit that has not been pushed — the link will 404 until it is. Note it if the batch ends unpushed


## Rules

- **Never launch before the user selects.** The checklist is the point of the command.
- **Both lists ship together.** Producing the checklist without the needs-attention list is an incomplete run.
- **A slice commits only its own files.** The orchestrator owns `CHANGELOG.md` and the full gate.
- **Excluded is a deliverable.** An issue you correctly refused to automate, with the reason, is worth as much as one you fixed.
- **Do not estimate effort or duration.**
- Never use emojis.
