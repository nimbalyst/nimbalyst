---
name: pull-prs
description: Pull open GitHub PRs into the github-pr tracker as backlog items
---

Sync open (non-draft) GitHub PRs into the `github-pr` tracker. New PRs land in
`backlog`; we manually move them through `inspecting -> needs-review | safe ->
complete (or rejected)` as we work through reviews.

## Steps

### 1. Fetch open PRs from GitHub

```bash
gh pr list \
  --state open \
  --limit 200 \
  --json number,title,url,author,headRefName,baseRefName,isDraft
```

Filter out PRs where `isDraft` is `true`.

### 2. Read existing tracker items

```
tracker_list({ type: "github-pr", limit: 500 })
```

Build a set of `prNumber` values already tracked. We dedupe on the PR number
field, not the URL, because URLs can shift if a fork is renamed.

### 3. Reconcile

For each PR from step 1:

- **Already tracked** -> skip (do NOT update; the tracker is the user's
  workspace of status, we don't want to clobber `inspecting`/`safe`/etc.)
- **Not tracked** -> create a new item with `tracker_create`:

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

For each tracked item whose `status` is not yet `complete` or `rejected` and
whose `prNumber` is **not** in the open-PR list from step 1, flag it as
**possibly stale** -- it may have been merged or closed on GitHub. Do not
auto-update; just surface it for the user.

### 4. Report

Print a compact summary:

- **N new** PRs added to backlog (list with `#num - title`)
- **N already tracked** (skipped)
- **N possibly stale** (in-progress tracker items whose PR is no longer open on
  GitHub -- include `#num - title - current status` for each)
- **N drafts skipped** (just the count, no list)

Do not auto-move stale items to `complete`. The user merges externally; they
flip status manually.

## Notes

- This command is read-only on GitHub. It only **creates** tracker items, never
  edits or deletes them.
- The `github-pr` tracker schema lives at
  `.nimbalyst/trackers/github-pr.yaml`. If it's not loaded, the user may need
  to switch workspaces or reload.
- Pair this command with `/review-contribution <PR#>` -- when you start a
  review, manually flip the item's status to `inspecting`; when done, flip to
  `needs-review` (maintainer should look) or `safe` (ready to merge).
