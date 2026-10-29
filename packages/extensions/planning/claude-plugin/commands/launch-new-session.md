---
description: Spin off a new AI session for unrelated work, a fresh continuation, or a worker
---

# /launch-new-session Command

Spin off a new AI session, e.g. "/launch-new-session and keep going on the tests" or "/launch-new-session to fix that unrelated bug". Pick the mode from what the user asked for:

- **Independent** (`isolated: true`): for work unrelated to the current task, e.g. "fix that other bug", "chase these down separately", "commit it on its own". The new session is a top-level session that shares no files-edited, tabs, or workstream overview with this one. Fire and forget: do not wait for it or check on it. `spawn_session` rejects `isolated: true` with any `reporting` other than `"none"`; if you need the result back, it is a Worker.

- **Continuation** (`besideCaller: true`): for the same work in a fresh session, usually to escape a long context. The new session sits beside this one in the session list, so a chain of handoffs stays flat.

- **Worker** (neither flag): for part of a task this session is coordinating, when the user asked it to orchestrate or parallelize work. The new session nests under this one in the session tree. Use `reporting: "final"` so the result comes back.

Reporting defaults to `"none"`: the calling session is not told when the new session finishes. Use `"final"` only for workers, or when the user asks for the result to come back here.

## Steps

When the user types `/launch-new-session [task description]`:

1. **Construct a self-contained handoff brief.** The new session will not see this conversation, so the brief must stand on its own. Include:
   - The task in 1-2 sentences (what to do, what success looks like)
   - Relevant file paths the new session should look at
   - Constraints or decisions already made in this session that affect the work
   - This pointer at the bottom: "For more context on what led to this task, call `get_session_summary` with `sessionId=<the current session id>`."

2. **Pick the mode** (see above). Unrelated work is Independent; "keep going", "continue", or a long context is Continuation; Worker only when this session is coordinating the work. When unsure between Independent and Continuation, ask whether the new work belongs to the current task.

3. **Decide on `useWorktree`.** Default to `false`. The default already inherits the caller's working directory: if the current session is running in a worktree, the spawned session runs in that same worktree (its edits land where the user is looking). Only set `true` when the user's phrasing implies the new session needs its OWN new branch / working directory — e.g. "in a new worktree", "in parallel without conflicts", "without touching my current branch". Note: `isolated` and `useWorktree` are independent — isolated alone still inherits the caller's working directory but separates the session record; combine with `useWorktree: true` to also branch off into a fresh worktree.

4. **Decide on `reporting`.** Omit it (fire and forget) for Independent and Continuation. Use `"final"` for a Worker, or when the user wants the result back in this session ("...and tell me when it's done").

5. **Decide on model.** By default the new session uses the app's global default model. Override only when the user asks for it:
   - If the user names a model ("...with opus", "...using sonnet"), pass that as `model` (e.g. `model: "claude-code:opus"`).
   - If the user says "same model", "keep the current model", or similar, pass `inheritModel: true` so the new session uses the caller's model.
   - `model` wins over `inheritModel` when both are set.

6. **Call `spawn_session`** with:
   - `prompt`: the handoff brief from step 1
   - `title`: a short descriptive title (e.g. "Finish auth tests")
   - `isolated: true` (Independent) or `besideCaller: true` (Continuation), per step 2
   - `useWorktree`: per step 3
   - `reporting`: per step 4
   - `model` / `inheritModel`: per step 5 (omit both to use the global default)

7. **Report back to the user** with:
   - The new session id
   - A one-line summary of what was handed off
   - The mode used: independent, continuation, or worker (and the worktree, if `useWorktree` was set)

## Notes

- Do NOT pre-summarize the parent session in the prompt beyond what's needed to act on the task. The new session can call `get_session_summary` if it needs more.
- Do NOT spawn a new session for trivial follow-ups that the current session can handle directly — `/launch-new-session` is for parallel work or context-escape hand-offs.
- The new session inherits the workspace; cross-workspace spawning is not supported.
