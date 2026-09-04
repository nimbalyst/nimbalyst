---
name: session-cleanup
description: Audit active Nimbalyst AI sessions and propose phase corrections (planning -> implementing -> validating -> complete) and archival candidates
---
# /session-cleanup Command

Audit active Nimbalyst AI sessions in this workspace and propose phase corrections and archival candidates. **Read-only by default**: produce a report grouped by recommended action, then wait for the user to approve before changing anything.

## Goal

Keep the kanban board honest:
- Sessions whose work is substantially done **and committed** should move toward `validating`/`complete`.
- **Review sessions whose PR has since merged** should move to `complete` — even without a `committed` tag. A review session lands its work by merging a PR on GitHub, not by committing locally, so the `committed` heuristic structurally misses them. See Step 2b.
- Sessions in the wrong phase (e.g. `planning` but code has already shipped) should be re-tagged.
- Sessions that are already `complete` are candidates for archival when the user has just cut a public release.
- Sessions that are uncommitted or only have a plan written are **not** candidates -- leave them alone.

## Step 1 -- gather the inventory

Use `list_recent_sessions` with a high limit and `includeArchived: false`. Page through if needed (offset). Skip sessions whose phase is already `complete` for the phase-correction pass (but include them when the user is in post-release archival mode -- see Step 5).

For each session, you have:
- `phase` (`backlog` | `planning` | `implementing` | `validating` | `complete`)
- `tags` (free-form, but the workspace conventions include `committed`, `uncommitted`, `planning`, `implementing`, `review`, plus area tags)
- title, last activity, etc.

## Step 2 -- classify cheaply from tags + phase

Most sessions can be classified without calling `get_session_summary`. Build a recommendation per session using only the metadata returned by `list_recent_sessions`:

| Phase | Tags | Recommendation |
| --- | --- | --- |
| any non-complete | has `committed`, no `uncommitted`, **and** phase is `validating` or `implementing` and clearly looks done from title/recent activity | candidate: **move to `complete`** (needs user approval) |
| any non-complete | title is a PR/contribution review (e.g. "Review contribution 698", "PR 731 review", "Review pull request 752") whose PR has **merged** on GitHub | candidate: **move to `complete`** regardless of `committed`/`uncommitted` tag — verify merge via Step 2b (needs user approval) |
| `planning` | has `committed` or `implementing` tag | wrong phase: **move to `implementing`** (or `validating` if also has `review`/`committed`) |
| `implementing` | has `review` tag and `committed` | wrong phase: **move to `validating`** |
| any non-complete | has `uncommitted` (no `committed`) | **leave alone** -- not ready |
| `planning` | only has `planning` / design tags, no `committed`/`implementing` | **leave alone** -- still planning |
| any non-complete | no tags at all | inspect with `get_session_summary` before recommending |

**Rules of thumb:**
- A session with **only** `uncommitted` (or with `uncommitted` and no `committed`) is never a complete/archive candidate.
- A session that's `planning` with **no** `committed`/`implementing` tags and only design/plan work is never a complete/archive candidate.
- `committed` + `validating` is the strongest signal that something is ready for `complete` -- but still surface it for user approval.

## Step 2b -- resolve PR/contribution review sessions via GitHub merge state

Review sessions (titles like `Review contribution NNN`, `Review pull request NNN`, `PR NNN review`) rarely carry a `committed` tag — the work lands when the PR merges on GitHub, not via a local commit. The `committed`/`uncommitted` heuristic therefore leaves them parked in `validating`/`implementing`/`planning` forever. Do **not** leave these alone by default. Instead:

1. Collect the PR number from each review session's title (any non-`complete` session whose title references a contribution/PR number).
2. Batch-check merge state with `gh` (the agent runs it — never ask the user):
   ```
   for n in <pr numbers>; do echo "PR $n: $(gh pr view $n --json state -q .state 2>/dev/null || echo NOTFOUND)"; done
   ```
3. **MERGED** → candidate for **move to `complete`** (ignore the `committed`/`uncommitted` tag entirely; the merge is the completion signal). Put these in the `moveToComplete` group.
4. **OPEN** / **CLOSED-unmerged** / **NOTFOUND** → leave alone (still in flight, or can't confirm).

This applies at **any** phase — a `planning`/`implementing` review session whose PR merged is done, not mid-work. This is the most common miss in prior runs; do not skip it.

## Step 3 -- inspect ambiguous sessions

For sessions where tags are missing, contradictory, or the title is uninformative, call `get_session_summary` with the session's `sessionId`. Use the summary's "Files Edited" list and last assistant response to decide:
- Files edited and the user's last prompt sounds like sign-off (e.g. "looks good", "ship it") -> candidate for `complete`.
- Files edited but the assistant's last response is mid-task or asking a question -> probably still `implementing` / `validating`.
- No files edited and only design discussion -> leave in `planning`.

Keep summary calls bounded -- don't call it for every session, only the ambiguous ones.

## Step 4 -- present the report and collect approval

First, output a short textual summary so the user has full context. Keep it terse: counts per group, plus the full "leave alone" and "inspected" lists (those won't appear in the approval prompt).

```
## Session cleanup audit

- Move to `complete`: {N}
- Move to `validating`: {N}
- Wrong phase corrections: {N}
- Leave alone: {N}
- Inspected with get_session_summary: {N}

### Leave alone (uncommitted / still planning / mid-work) -- {N}
- {sessionId} -- "{title}" -- {brief reason}

### Inspected with get_session_summary -- {N}
- {sessionId} -- {what the summary revealed and how it shaped the recommendation}
```

Then call `PromptForUserInput` to collect approval as structured input. Use one `multiSelect` field per non-empty actionable group, with every recommended session pre-checked (`defaultChecked: true`) so the user can uncheck anything they want to skip. Skip groups that have zero candidates. If every group is empty, do not call the prompt -- just report "nothing to do" and stop.

```
PromptForUserInput({
  title: "Apply session cleanup",
  intro: "Uncheck anything you don't want applied. Submit to apply the rest.",
  submitLabel: "Apply changes",
  cancelLabel: "Skip",
  fields: [
    // include only groups with at least one candidate
    {
      type: "multiSelect",
      id: "moveToComplete",
      label: "Move to `complete`",
      description: "Committed and work looks done.",
      items: [
        {
          id: "{sessionId}",
          title: "{title}",
          subtitle: "phase: {phase} -> complete | tags: {tags} | why: {one short sentence}",
          defaultChecked: true
        }
        // ...
      ]
    },
    {
      type: "multiSelect",
      id: "moveToValidating",
      label: "Move to `validating`",
      description: "Committed, ready for review.",
      items: [ /* { id: sessionId, title, subtitle: "phase: {phase} -> validating | ...", defaultChecked: true } */ ]
    },
    {
      type: "multiSelect",
      id: "wrongPhase",
      label: "Wrong phase corrections",
      description: "Phase doesn't match observed activity.",
      items: [ /* { id: sessionId, title, subtitle: "phase: {current} -> {proposed} | ...", defaultChecked: true } */ ]
    }
  ]
})
```

The `id` of each item must be the `sessionId` so Step 6 can apply changes directly from the response payload. The `subtitle` should encode the proposed phase change so the user can see at a glance what they are approving.

If the user cancels the prompt, do not make any changes -- print "No changes applied." and stop.

## Step 5 -- post-release archival mode (only when user asks)

If the user passes `--post-release` (or otherwise indicates they just cut a public release and want to archive completed sessions), do a second pass:

1. Re-run `list_recent_sessions` with `includeArchived: false` and find sessions whose phase is `complete`.
2. List them as archival candidates -- one bullet each.
3. Tell the user that **archiving must be done from the Nimbalyst UI** -- the MCP tools available here (`update_session_meta`, `update_session_board`) can change phase and tags but do not expose an `archived` flag for sessions. (As of writing, `update_session_board` accepts `phase: null` to remove the session from the board, which is *not* the same as archiving and should not be used as a substitute.)
4. Offer to instead retag the completed sessions with an `archived-candidate` tag so the user can find them quickly when archiving from the UI.

## Step 6 -- apply approved changes

Read the `PromptForUserInput` response payload. It is keyed by field id (`moveToComplete`, `moveToValidating`, `wrongPhase`) and each value is the array of selected session IDs (the items the user left checked).

For each selected session:

- Use `mcp__nimbalyst-session-context__update_session_board` with `sessionId` to change `phase` and/or `tags`. **This is the only tool that accepts a `sessionId`** -- use it for every cross-session update in this command.
- **Never** use `mcp__nimbalyst-session-naming__update_session_meta` here. That tool has no `sessionId` parameter and silently updates the *current* (orchestrator) session instead of the target -- it will mis-flag this `/session-cleanup` session itself as `complete`.
- `update_session_board` `tags` is a full replacement, not a delta. To preserve existing tags while adding/removing, fetch them from the inventory in Step 1 and pass the merged array.
- **Never** set `phase: "complete"` for any session that did not appear (and remain checked) in the `moveToComplete` field of the response. A user submitting the prompt with that session checked counts as explicit approval; an unchecked or absent session does not.
- **Never** set `phase: null` -- that removes the session from the board entirely and is not what the user asked for.

After applying, print a one-line confirmation per session: `{sessionId} -> {newPhase}, tags: +{added} -{removed}`.

## Constraints

- Read-only until the user confirms. The default behavior of this command is to produce a report and stop.
- Don't call `get_session_summary` for every session -- it's expensive. Use it only for ambiguous cases.
- Don't recommend `complete` for anything tagged `uncommitted`. Ever. This is the user's hard rule. **Exception:** a PR/contribution review session whose PR has merged (confirmed via Step 2b) — the merge, not the tag, is the completion signal.
- Don't recommend `complete` for sessions that only contain design/plan work (no `committed` tag, no implementing activity) — unless it's a review session with a merged PR (Step 2b).
- Don't archive anything from this command -- archival is a UI action the user performs after a public release.
- Match scope to what the user asked: if they typed `/session-cleanup` with no args, only do the phase-correction pass (Steps 1-4 + 6); only do the post-release archival pass when they explicitly opt in.
