# Tracker Workflows

This doc covers tracker-item workflows for decisions and bugs.

## Recording Decisions

Record a decision where the next reader will look for it. Not every choice needs a record; most need one sentence in the right place.

**In a project with a Wiki,** follow the project's "How we write this wiki" page. In short: mark the decision by default, as one sentence in the page it affects, with who decided, when, and what was not chosen. Also add a **decision** tracker item when any of these holds:

1. No single page owns it: it changes behavior across several areas, both repos, or every client.
2. Work or code hangs off it: commits close it with `Fixes NIM-…`, or tasks and other decisions depend on it.
3. It is not settled: it is still being evaluated, or it holds only while something stays true and someone has to watch that.
4. The reasons don't fit in a mark: more than one alternative worth keeping, or reasoning a later agent must read in full before undoing it.

A record never replaces the mark. Keep the mark and put the record's key right after it.

**Without a Wiki,** write the decision in the plan doc it belongs to. Use a decision tracker item when there is no plan doc or one of the four conditions above holds.

**How to create a record:**

```
tracker_create({
  type: "decision",
  title: "{what you decided}",
  priority: "medium",  // or "high" for architectural decisions
  labels: ["{area}"],  // e.g., "extensions", "ai", "sync", "ui"
  description: `## Context\n{why this came up}\n\n## Alternatives considered\n{what else was on the table}\n\n## Reasoning\n{why this option won}\n\n## Trade-offs accepted\n{what you gave up}`
})
```

**Before making a similar decision**, read the page about the thing it governs and search existing decisions with `tracker_list({ type: "decision", search: "{topic}" })`. Follow prior decisions unless new information invalidates the reasoning. In that case, rewrite the marked sentence and say what it replaced and when; update or supersede the record if there is one.

## Bug Tracking

When fixing a bug, **always ensure a tracker bug item exists** before starting the fix. If the user hasn't already pointed you at an existing tracker item, create one immediately using `tracker_create`.

**Workflow:**
1. **Check for existing bug**: `tracker_list({ type: "bug", search: "{topic}" })` — if one exists, link to it with `tracker_link_session`
2. **Create if missing**: If no tracker item exists, create one before writing any fix code
3. **Keep it updated**: Update the tracker item's status as you progress (`to-do` → `in-progress` → `in-review`)
4. **Link the session**: Always call `tracker_link_session` so the bug and session are cross-referenced
5. **Close it on the commit**: When the user commits the fix, put a closing reference on its own line in the commit message — `Fixes NIM-123`, using the item's issue key. That commit is the user's sign-off, and `CommitTrackerLinker` moves the item to `done` and marks the session `complete`. A bare `NIM-123` only links the commit; it does not close.

Do not stop at step 3. An item left in `in-review` after its fix shipped is a false backlog entry — the user has to clear it by hand. If the item has no issue key, say so when you propose the commit rather than silently omitting the reference.

`Fixes NIM-123` belongs in the **commit message only**. Issue keys are scoped to a tracker room or local workspace: peers in the same room share an identity, but the same key can name a different item in an unrelated workspace. A `NIM-###` in a code comment or runtime log string therefore means nothing reliable to anyone reading this public repo. Cite the GitHub issue (`#123`) there instead. See the tracker-key rule in [CLAUDE.md](../CLAUDE.md).

**How to create:**

```
tracker_create({
  type: "bug",
  title: "{concise description of the bug}",
  priority: "medium",  // or "high"/"critical" based on severity
  labels: ["{area}"],  // e.g., "ios", "electron", "sync", "ui"
  description: `## Symptoms\n{what the user sees}\n\n## Expected behavior\n{what should happen}\n\n## Root cause\n{fill in once diagnosed}\n\n## Fix\n{fill in once implemented}`
})
```

**As the fix progresses**, update the description with root cause and fix details using `tracker_update`. This creates a durable record of what was wrong and how it was fixed.
