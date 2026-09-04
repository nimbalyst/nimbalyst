---
name: review-pr
description: Pull a GitHub PR into the standard review worktree, merge current main, and prep it for hands-on local testing on the dev:user2 instance
---
Help the user hands-on test a GitHub PR locally. Argument: a PR number (e.g. `/review-pr 711`).

Prefer other approaches when they fit better:
- Renderer-only PR, quick look, no second instance needed -> suggest an in-place branch switch in the user's main checkout (`gh pr checkout <N>`); HMR picks it up, no worktree, no install.
- Read-only code review with no need to run it -> that's `/review-branch` or `/review-contribution`, not this.
This command is for when the user wants to actually RUN the PR against a live app alongside their main dev instance.

**Steps:**

1. **Prep the worktree** — run the script (do NOT pass `--run`; the user launches dev themselves):
   ```bash
   scripts/review-pr.sh <PR_NUMBER>
   ```
   This reuses the single standard review worktree (`<repo>_worktrees/pr-review`), fetches the PR, checks it out onto a throwaway `pr-review` branch, merges today's `origin/main`, and runs an incremental `npm install`. node_modules is installed once and reused across PRs.

2. **Report what the merge revealed.** The script auto-resolves `CHANGELOG.md` conflicts. If it exits with real source conflicts (exit code 2), that is a genuine review finding — tell the user the PR does not cleanly apply on top of current main, list the conflicted files, and offer to either resolve them or re-run with `--no-merge` to test the PR as-authored. Also report how stale the PR is (commits behind main, base date) using:
   ```bash
   git -C <repo>_worktrees/pr-review rev-list --count pr-<N>..origin/main
   ```

3. **Hand off the launch command** — do NOT run `npm run dev` yourself (house rule). Give the user:
   ```
   cd <repo>_worktrees/pr-review/packages/electron && npm run dev:user2
   ```
   Remind them this runs on port 5274 with an isolated `electron-user2` userData dir, so it does NOT disturb their main dev instance on 5273 and does NOT share (or risk corrupting) its SQLite database. It does NOT kill their main instance the way `crystal-run.sh` would.

4. **Once it's running, help verify the PR end-to-end.** Read the PR diff (`gh pr diff <N>`) to understand what changed, then drive/inspect the actual behavior with the renderer/log tools rather than just reading code. Focus on the user-visible flow the PR touches.

**Flags to mention when relevant:**
- `--no-merge` — test the PR exactly as-authored (skip merging current main)
- `--skip-install` — skip npm install when deps are known-unchanged
- `--run` — the script launches `dev:user2` itself (for the USER to use directly; the agent should not pass this)

**Cleanup** (only if the user asks): the worktree is meant to persist and be reused. To reclaim it just re-run the command with the next PR number — it resets `pr-review` to the new PR automatically. Never delete the worktree as part of normal flow (that throws away the shared node_modules).
