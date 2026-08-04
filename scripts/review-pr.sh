#!/bin/bash
# review-pr.sh — prep a GitHub PR for hands-on local review in ONE reusable worktree.
#
# What it does:
#   1. Reuses a single standard review worktree (<repo>_worktrees/pr-review) so
#      node_modules is installed once, not per-PR.
#   2. Fetches the PR head and checks it out onto a throwaway `pr-review` branch.
#   3. Merges today's origin/main on top so you test the PR against current code,
#      not the (possibly weeks-old) base it was branched from. CHANGELOG.md
#      conflicts are auto-resolved (they never affect runtime); any real source
#      conflict stops the script — that itself is a review finding.
#   4. Runs an incremental `npm install` (only the dep delta).
#   5. Prints the dev:user2 launch command (isolated userData + port 5274), or
#      launches it directly with --run.
#
# Usage:
#   scripts/review-pr.sh <PR_NUMBER> [--run] [--no-merge] [--skip-install]
#
#   --run           launch `npm run dev:user2` when prep finishes (default: just print the command)
#   --no-merge      test the PR exactly as-authored, without merging current main
#   --skip-install  skip npm install (use when you know deps are unchanged)

set -euo pipefail

PR=""
DO_RUN=false
DO_MERGE=true
DO_INSTALL=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run) DO_RUN=true ;;
    --no-merge) DO_MERGE=false ;;
    --skip-install) DO_INSTALL=false ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) if [[ -z "$PR" ]]; then PR="$1"; else echo "Unexpected arg: $1" >&2; exit 1; fi ;;
  esac
  shift
done

if [[ -z "$PR" || ! "$PR" =~ ^[0-9]+$ ]]; then
  echo "Usage: scripts/review-pr.sh <PR_NUMBER> [--run] [--no-merge] [--skip-install]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The main working tree is the first entry of `git worktree list`.
MAIN_REPO_ROOT="$(git -C "$SCRIPT_DIR" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
REVIEW_WT="${MAIN_REPO_ROOT}_worktrees/pr-review"

# Safety guard: we hard-reset the review worktree below, so refuse to touch
# anything that isn't the dedicated disposable review path.
case "$REVIEW_WT" in
  *_worktrees/pr-review) : ;;
  *) echo "Refusing to operate on unexpected path: $REVIEW_WT" >&2; exit 1 ;;
esac

echo ">> Main repo:      $MAIN_REPO_ROOT"
echo ">> Review worktree: $REVIEW_WT"

# 1. Ensure the standard review worktree exists (create + install once, ever).
if [[ ! -d "$REVIEW_WT" ]]; then
  echo ">> Creating standard review worktree (one-time)..."
  git -C "$MAIN_REPO_ROOT" worktree add --detach "$REVIEW_WT"
  DO_INSTALL=true
fi

# 2. Fetch the PR head and current main.
echo ">> Fetching PR #$PR and origin/main..."
git -C "$REVIEW_WT" fetch --quiet origin main
git -C "$REVIEW_WT" fetch --quiet origin "+pull/$PR/head:refs/heads/pr-$PR"

# 3. Reset the disposable worktree and check the PR out onto `pr-review`.
git -C "$REVIEW_WT" reset --hard --quiet
git -C "$REVIEW_WT" switch -C pr-review "pr-$PR" --quiet
echo ">> Checked out PR #$PR onto branch pr-review"

# 4. Merge today's main (unless --no-merge).
if [[ "$DO_MERGE" == true ]]; then
  echo ">> Merging origin/main..."
  if git -C "$REVIEW_WT" merge --no-edit origin/main; then
    echo ">> Merged main cleanly."
  else
    CONFLICTS="$(git -C "$REVIEW_WT" diff --name-only --diff-filter=U | tr '\n' ' ' | sed 's/ *$//')"
    if [[ "$CONFLICTS" == "CHANGELOG.md" ]]; then
      git -C "$REVIEW_WT" checkout --theirs CHANGELOG.md
      git -C "$REVIEW_WT" add CHANGELOG.md
      git -C "$REVIEW_WT" commit --no-verify --no-edit >/dev/null
      echo ">> Auto-resolved CHANGELOG.md conflict (kept main's; harmless for testing)."
    else
      echo ""
      echo "!! REAL CONFLICTS merging current main into PR #$PR:"
      echo "!!   $CONFLICTS"
      echo "!! This PR does not cleanly apply on top of today's main — a review finding."
      echo "!! Resolve manually in $REVIEW_WT, or re-run with --no-merge to test the PR as-authored."
      exit 2
    fi
  fi
else
  echo ">> Skipping main merge (--no-merge): testing PR as-authored."
fi

# 5. Incremental dependency install.
if [[ "$DO_INSTALL" == true ]]; then
  echo ">> npm install (incremental)..."
  ( cd "$REVIEW_WT" && npm install )
else
  echo ">> Skipping npm install (--skip-install)."
fi

echo ""
echo "=============================================================="
echo " PR #$PR ready for review in:"
echo "   $REVIEW_WT"
echo ""
echo " Launch the isolated test instance (userData: electron-user2, port 5274):"
echo "   cd \"$REVIEW_WT/packages/electron\" && npm run dev:user2"
echo "=============================================================="

if [[ "$DO_RUN" == true ]]; then
  echo ">> Launching dev:user2..."
  cd "$REVIEW_WT/packages/electron"
  exec npm run dev:user2
fi
