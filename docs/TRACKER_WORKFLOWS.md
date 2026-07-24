# Tracker Workflows

This doc covers tracker-item workflows for decisions and bugs.

## Decision Logging

When choosing between alternatives that affect more than the immediate task — a library, an architecture pattern, an API design, or deciding NOT to do something — log it as a **decision** tracker item using `tracker_create`.

**When to log:**
- Choosing a library or dependency
- Picking an architecture pattern over alternatives
- Designing an API contract or data model
- Deciding NOT to do something (e.g., "we won't use Redux because...")
- Any choice where future-you would ask "why did we do it this way?"

**How to log:**

```
tracker_create({
  type: "decision",
  title: "{what you decided}",
  priority: "medium",  // or "high" for architectural decisions
  labels: ["{area}"],  // e.g., "extensions", "ai", "sync", "ui"
  description: `## Context\n{why this came up}\n\n## Alternatives considered\n{what else was on the table}\n\n## Reasoning\n{why this option won}\n\n## Trade-offs accepted\n{what you gave up}`
})
```

**Before making a similar decision**, search existing decisions with `tracker_list({ type: "decision", search: "{topic}" })`. Follow prior decisions unless new information invalidates the reasoning — in which case, log a new decision that supersedes the old one and reference it.

## Bug Tracking

When fixing a bug, **always ensure a tracker bug item exists** before starting the fix. If the user hasn't already pointed you at an existing tracker item, create one immediately using `tracker_create`.

**Workflow:**
1. **Check for existing bug**: `tracker_list({ type: "bug", search: "{topic}" })` — if one exists, link to it with `tracker_link_session`
2. **Create if missing**: If no tracker item exists, create one before writing any fix code
3. **Keep it updated**: Update the tracker item's status as you progress (`to-do` → `in-progress` → `in-review`)
4. **Link the session**: Always call `tracker_link_session` so the bug and session are cross-referenced

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
