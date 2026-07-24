---
description: Tidy your Sessions board -- fix each session's phase, mark finished work complete, and flag old sessions to archive
---

# /session-cleanup Command

Audit your AI sessions and tidy the Sessions board. **Read-only by default**: produce a short report grouped by recommended action, then wait for your approval before changing anything.

## Goal

Keep the Sessions board honest:
- Sessions whose work is done and committed should move toward `validating` / `complete`.
- Sessions in the wrong column (e.g. `planning` but code already shipped) should be re-phased.
- Sessions that are already `complete` are candidates to archive.
- Sessions that are uncommitted or only have a plan written are **left alone** -- they are not done.

## Step 1 -- gather the inventory

Call `list_recent_sessions` with a high `limit` and `includeArchived: false`. Page with `offset` if there are more. Each session gives you:
- `phase` (`backlog` | `planning` | `implementing` | `validating` | `complete`, or none)
- `tags` (free-form; common ones: `committed`, `uncommitted`, `review`, plus area tags)
- title and last activity

## Step 2 -- classify from phase + tags

Most sessions can be classified from the metadata alone, without reading the transcript:

| Current phase | Tags / signal | Recommendation |
| --- | --- | --- |
| `validating` or `implementing` | has `committed`, no `uncommitted`, and the title/activity looks finished | **move to `complete`** |
| `planning` | has `committed` or implementation activity | **move to `implementing`** (or `validating` if also reviewed/committed) |
| `implementing` | reviewed and `committed` | **move to `validating`** |
| any non-complete | has `uncommitted` (and no `committed`) | **leave alone** -- not ready |
| `planning` | only design/plan work, no `committed` | **leave alone** -- still planning |
| any non-complete | no tags and an uninformative title | inspect with `get_session_summary` before deciding |

**Rules of thumb:**
- A session with only `uncommitted` work is never a `complete` or archive candidate.
- A `planning` session with no committed/implementation work is never a `complete` candidate.
- `committed` + `validating` is the strongest "ready for `complete`" signal -- still surface it for approval.

## Step 3 -- inspect only the ambiguous ones

When tags are missing, contradictory, or the title is uninformative, call `get_session_summary` with that `sessionId`. Use its files-edited list and last response:
- Files edited and the last message reads like sign-off ("looks good", "ship it") -> candidate for `complete`.
- Files edited but the assistant is mid-task or asking a question -> still `implementing` / `validating`.
- No files edited, only discussion -> leave in `planning`.

Keep these calls bounded -- only for genuinely ambiguous sessions, not every one.

## Step 4 -- report, then collect approval

Print a terse summary first (counts per group, plus the full "leave alone" and "inspected" lists so they have context):

```
## Session cleanup audit

- Move to `complete`: {N}
- Move to `validating`: {N}
- Wrong-phase corrections: {N}
- Leave alone: {N}
- Inspected: {N}

### Leave alone -- {N}
- {title} -- {brief reason}
```

Then call `PromptForUserInput` with one `multiSelect` field per non-empty actionable group, every recommended session pre-checked (`defaultChecked: true`) so the user only unchecks what they want to skip. Skip empty groups. If nothing is actionable, say "Nothing to clean up" and stop -- do not show the prompt.

```
PromptForUserInput({
  title: "Apply session cleanup",
  intro: "Uncheck anything you don't want applied. Submit to apply the rest.",
  submitLabel: "Apply changes",
  cancelLabel: "Skip",
  fields: [
    {
      type: "multiSelect",
      id: "moveToComplete",
      label: "Move to complete",
      items: [
        { id: "{sessionId}", title: "{title}", subtitle: "phase: {phase} -> complete | why: {one sentence}", defaultChecked: true }
      ]
    },
    {
      type: "multiSelect",
      id: "moveToValidating",
      label: "Move to validating",
      items: [ /* { id: sessionId, title, subtitle, defaultChecked: true } */ ]
    },
    {
      type: "multiSelect",
      id: "wrongPhase",
      label: "Wrong-phase corrections",
      items: [ /* { id: sessionId, title, subtitle: "phase: {current} -> {proposed} | ...", defaultChecked: true } */ ]
    }
  ]
})
```

Each item's `id` MUST be the `sessionId` so Step 6 can apply changes directly from the response. If the user cancels, make no changes -- print "No changes applied." and stop.

## Step 5 -- archiving old sessions (offer, don't auto-do)

After the phase pass, find sessions whose phase is `complete` (re-run `list_recent_sessions` if needed) and offer them as archive candidates.

**Archiving is a UI action, not an MCP one.** The tools here can change phase and tags but cannot set the archived flag. So:
1. List the `complete` sessions as archive candidates -- one line each.
2. Tell the user to archive them from the **Sessions board**: right-click a session (or multi-select) and choose **Archive**.
3. Offer to tag the candidates with `archived-candidate` (via `update_session_board`) so they are easy to find and bulk-archive in the UI.

Never claim a session was archived -- you can only flag candidates.

## Step 6 -- apply approved phase/tag changes

Read the `PromptForUserInput` response (keyed by field id: `moveToComplete`, `moveToValidating`, `wrongPhase`; each value is the array of still-checked session IDs). For each selected session:

- Use `update_session_board` with the `sessionId` to set `phase` and/or `tags`. **This is the only tool that takes a `sessionId`** -- use it for every cross-session update.
- **Never** use `update_session_meta` here -- it has no `sessionId` and silently edits the *current* session instead of the target, mis-flagging this cleanup session itself.
- `update_session_board` `tags` is a full replacement, not a delta. To add/remove a tag while keeping the rest, merge against the tags you read in Step 1 and pass the full array.
- Only set `phase: "complete"` for sessions the user left checked under `moveToComplete`.
- **Never** pass `phase: null` -- that removes the session from the board, which is not what was asked.

Print one confirmation line per session: `{title} -> {newPhase}` (and any tag changes).

## Constraints

- Read-only until the user approves. Default behavior is report-then-stop.
- Don't call `get_session_summary` for every session -- only the ambiguous ones.
- Never mark a session `complete` while it has uncommitted work or is only a plan.
- Never archive from this command -- archiving is a UI action the user performs.
