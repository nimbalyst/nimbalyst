## Never add restrictions nobody asked for

A feature or fix must not make an existing behavior more restrictive unless the user explicitly asked for that restriction. This covers pausing or disabling auto-commit or auto-approve, forcing manual approval, adding confirmations, refusing inputs that used to work, and narrowing a permission or setting. A user's setting means what it says; do not add "safety" exceptions that override it.

- If you think a restriction is warranted, ask it as its own question with the interactive question tool, naming exactly what stops working and for whom. Never bundle it into a recommended option for a different question, and never record it as "decided" because an adjacent choice was approved.
- A new path (a new target, input shape, or entry point) gets the same automation as the existing paths unless the user decided otherwise.
- When reviewing a plan or diff, flag any line that turns automation off or adds a gate the request did not mention.

Incident: #1756 (2026-10-16) made every commit into another worktree manual, and #1955 (2026-11-13) paused auto-commit when a folder contained files another session had edited. Neither was requested; the second was folded into a recommended option about widget checkboxes. Agents working in their own worktrees stopped on every commit, which broke many users' workflows until #1968 removed both.
