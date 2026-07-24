---
description: Git pull, resolve conflicts, push, fix hook errors, then release
---
**Arguments**: `{{arg1}}`
- First word: release type (patch, minor, major) — defaults to "patch" if omitted
- If second word is "auto": passed through to `/release-alpha` (skips approval prompts)

Run the full push-and-release workflow:

## 1. Git Pull

- Run `git pull origin main --rebase`
- If there are merge/rebase conflicts:
  - Analyze the conflicts and resolve them intelligently (prefer incoming changes for version bumps, preserve local changes for code)
  - Stage resolved files and continue the rebase: `git rebase --continue`
  - If resolution is ambiguous, stop and ask the user

## 2. Fix Git Hook Errors

- If any git hooks (pre-commit, commit-msg, etc.) fail during the pull/rebase:
  - Read the error output
  - Fix the issues (linting, formatting, type errors, etc.)
  - Stage fixes and retry the operation
  - Repeat until hooks pass

## 3. Git Push

- Push to origin: `git push origin main`
- If push is rejected (e.g., non-fast-forward), pull again and repeat from step 1
- Verify push succeeded

## 4. Release

- Extract the release type from `{{arg1}}` (default: "patch")
- Determine if "auto" was specified
- Run `/release-alpha {{arg1}}` (or `/release-alpha patch` if no args given)
- This delegates to the full release workflow including changelog, version bump, tagging, and pushing the release

## Error Recovery

- If any step fails, diagnose the root cause before retrying
- Never force-push or use destructive git operations without asking the user
- If stuck after reasonable attempts, stop and explain the situation to the user
