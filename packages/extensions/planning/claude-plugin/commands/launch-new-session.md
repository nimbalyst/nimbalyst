---
description: Spin off a new AI session to work on a side task in parallel
---

# /launch-new-session Command

Spin off a new AI session to keep working on a side task without losing context —
e.g. "/launch-new-session and keep going on the tests". Two modes:

- **Sibling** (default): the new session joins the same workstream as the caller
  and shares files-edited, tabs, and `get_workstream_overview`. If the caller is
  not yet part of a workstream, a workstream container is created and the caller
  is reparented under it. Use for parallel work on the same overall feature/area.

- **Isolated** (`isolated: true`): the new session is created at the top level
  with no parent and no workstream container. Files-edited, tabs, and workstream
  overview are NOT shared with the caller. Use when the new session should
  fix-and-commit work independently — e.g. "spin up a session to chase down these
  unrelated bugs and commit them separately".

A common use case across both modes is **escaping a long context**: the current
session has accumulated too much history to keep going productively, so kick the
remaining work off into a fresh session.

By default the call is **fire-and-forget**: the calling session is not notified
when the spawned session completes. Pass `notifyOnComplete: true` only when the
caller specifically wants to wait for the result.

## Steps

When the user types `/launch-new-session [task description]`:

1. **Construct a self-contained handoff brief.** The new session will not see this
   conversation, so the brief must stand on its own. Include:
   - The task in 1-2 sentences (what to do, what success looks like)
   - Relevant file paths the new session should look at
   - Constraints or decisions already made in this session that affect the work
   - This pointer at the bottom: "For more context on what led to this task, call
     `get_session_summary` with `sessionId=<the current session id>`."

2. **Decide on `isolated`.** Default to `false` (sibling mode). Set `true` when
   the user's phrasing implies the new work should be tracked and committed
   separately from the current session — e.g. "isolated bugs", "fix and commit
   separately", "without polluting this workstream", "as its own session".

3. **Decide on `useWorktree`.** Default to `false`. The default already inherits
   the caller's working directory: if the current session is running in a
   worktree, the spawned session runs in that same worktree (its edits land
   where the user is looking). Only set `true` when the user's phrasing implies
   the new session needs its OWN new branch / working directory — e.g. "in a
   new worktree", "in parallel without conflicts", "without touching my current
   branch". Note: `isolated` and `useWorktree` are independent — isolated alone
   still inherits the caller's working directory but separates the session
   record; combine with `useWorktree: true` to also branch off into a fresh
   worktree.

4. **Decide on `notifyOnComplete`.** Default to `false` (fire-and-forget). Only
   set `true` if the user's phrasing implies they want the result back in this
   session ("...and tell me when it's done", "...and bring back the answer").

5. **Call `spawn_session`** with:
   - `prompt`: the handoff brief from step 1
   - `title`: a short descriptive title (e.g. "Finish auth tests")
   - `isolated`: per step 2 (omit to use the default)
   - `useWorktree`: per step 3
   - `notifyOnComplete`: per step 4 (omit to use the default)

6. **Report back to the user** with:
   - The new session id
   - A one-line summary of what was handed off
   - The mode used: "sibling under workstream X", "isolated top-level session",
     or "isolated session in worktree Y"
   - A note that the current session is now part of a workstream (if
     `promotedParent` came back true in the tool result — only happens in sibling
     mode)

## Notes

- Do NOT pre-summarize the parent session in the prompt beyond what's needed to
  act on the task. The new session can call `get_session_summary` if it needs
  more.
- Do NOT spawn a new session for trivial follow-ups that the current session can
  handle directly — `/launch-new-session` is for parallel work or context-escape
  hand-offs.
- The new session inherits the workspace; cross-workspace spawning is not
  supported.
