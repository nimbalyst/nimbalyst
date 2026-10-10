---
description: Execute a plan document with progress tracking
---

# /implement [plan-file-path]

Implement a plan and keep its checklist current as you go. A bare filename means `nimbalyst-local/plans/<name>`.

## Steps

1. **Read the whole plan.** Missing file: ask for the path. No frontmatter: warn it isn't a plan. Already complete or `blocked`: ask before proceeding.

2. **Link the session.** `tracker_get` with `fm:plan:<workspace-relative-path>`, then `tracker_link_session` with the returned id. Never create a second tracker item.

3. **Checklist.** Reuse an existing `## Implementation checklist` (or legacy `## Implementation Progress`); add missing deliverables to it. Otherwise create one under the intro: one `- [ ]` per phase, sub-items for deliverables. Don't otherwise restructure the plan.

4. **Frontmatter, before any code** (even if the checklist already existed): `status: in-development`, `startDate` if unset, `updated` to now (ISO), `progress` to the checked fraction.

5. **Implement, ticking as you go.** When a phase or deliverable lands, edit the plan in the same turn, before starting the next item: tick the box, set `progress` (checked / total boxes in the checklist, rounded) and `updated`. If you're about to report a phase done without having just edited the plan, edit it first. Never batch ticks to the end. On a blocker, set `status: blocked` and note why.

6. **Finish.** Check each box against what actually shipped; leave unfinished items unchecked and say why. Then `status: in-review`, `progress: 100`. Fix failing tests, never skip them. If the project keeps a feature inventory, update it for notable capabilities added or removed, or report "No inventory impact". Don't commit unless asked.
