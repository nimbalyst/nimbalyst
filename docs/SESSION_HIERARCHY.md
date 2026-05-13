# Session Hierarchy

Authoritative rules for how `ai_sessions` rows nest. Read this before touching any
code that creates a session, parents one session under another, or groups sessions
for display.

## The two-layer invariant

**Sessions nest at most one level deep.** A session is either a root or a child of
a root — never a grandchild. Equivalent statements:

- `parent_session_id` of a row's parent **must** be `NULL`.
- A `session_type='workstream'` row **must not** itself have a `parent_session_id`.
- Three layers (workstream → workstream → session, or worktree → workstream → session)
  is a bug, not a feature.

## Roles

Three structural roles exist; they're determined by the combination of
`session_type`, `parent_session_id`, and `worktree_id`:

| Role | `session_type` | `parent_session_id` | `worktree_id` | Notes |
| --- | --- | --- | --- | --- |
| Standalone session | `'session'` | `NULL` | `NULL` | A solo session in the workspace root. |
| Workstream parent | `'workstream'` | `NULL` | `NULL` | Empty container that groups children. **Never** has `worktree_id`. |
| Workstream child | `'session'` | parent's id | `NULL` | Real session belonging to a workstream group. |
| Worktree-resident session | `'session'` | `NULL` | worktree id | Real session inside a worktree. Flat sibling of every other session in the same worktree. |
| Blitz parent | `'blitz'` | `NULL` | `NULL` | Group container for blitz worktrees (one blitz spawns N worktrees). |

Anything outside these shapes is wrong. In particular:

- ❌ `session_type='workstream'` **and** `worktree_id IS NOT NULL` — see "A worktree is the workstream" below.
- ❌ `parent_session_id IS NOT NULL` **and** `worktree_id IS NOT NULL` — children inherit the worktree via the parent's grouping; setting both produces double-counting in `worktreeGroupsData`.
- ❌ A `session_type='workstream'` row whose parent is itself a workstream.

## A worktree IS the workstream

The `worktrees` table row is the container for every session attached to that
worktree. There is no separate `session_type='workstream'` row representing the
worktree — the worktree row plays that role.

Concretely: every session inside a worktree is a flat sibling of every other
session in that worktree. They all carry the same `worktree_id` and have
`parent_session_id = NULL`. The left pane's `worktreeGroupsData` (in
`SessionHistory.tsx`) groups them on `worktree_id` alone — that's how they show
up under one "worktree" group entry.

Creating a `session_type='workstream'` row for a worktree (with or without
`worktree_id` set on the row, with or without children parented under it) is
**always wrong**. It produces a forbidden third layer and the workstream's
children disappear from the left pane (they get filtered out of `sessionListRootAtom`
by `parent_session_id IS NOT NULL` but never re-surface via worktree grouping
because the worktree group only sees root rows).

## Code paths that enforce this

These are the points where the invariant is currently maintained. Any new
session-creation path you add must respect the same rules.

| Location | Enforces |
| --- | --- |
| `packages/electron/src/main/services/MetaAgentService.ts` → `resolveOrCreateWorkstream` | If `parent.worktreeId` is set, returns `workstreamId: null` immediately — never wraps the parent in a workstream container. The new child becomes a flat sibling in the worktree. |
| `packages/electron/src/renderer/store/atoms/sessions.ts` → `convertToWorkstreamAtom` | Refuses to convert a session that already has `worktreeId`. Also never sets `worktreeId` on the workstream row it creates. |
| `packages/electron/src/main/database/worker.js` | One-time migration deletes accidental worktree-attached workstream rows (guarded by `NOT EXISTS (… ai_agent_messages …)` so user content is never lost). Children auto-unparent via `parent_session_id`'s `ON DELETE SET NULL`. |

## Rules of thumb for new code

1. **Adding a new "create session" path?** Decide which role you're creating
   (standalone, workstream child, or worktree-resident) and set the three fields
   to match the table above. Do not invent a fourth shape.
2. **Adding a new "spawn from existing session" path?** Mirror
   `resolveOrCreateWorkstream`: if the source is in a worktree, the new session
   is a flat sibling in that worktree (no workstream involved). Otherwise, route
   through the workstream parent if one exists or create one.
3. **Adding a new grouping derivation in the renderer?** Don't assume that
   workstream parents and worktrees are disjoint roots — they are, but verify
   that your derivation doesn't double-count a worktree-resident session under
   both its worktree group and some other grouping.
4. **Got a "session has no parent but I expected one" bug?** First check the
   table above. If the missing-parent case isn't represented there, you've
   either found a bug in this doc or you're trying to invent a fourth shape.

## Why this matters

When the invariant breaks, the left pane silently swallows sessions:

- `sessionListRootAtom` filters out anything with `parent_session_id` set.
- `worktreeGroupsData` only sees root rows, so children of a worktree-attached
  workstream (the forbidden third layer) disappear from both groupings.
- The user sees their worktree as "containing 4 sessions" when 10 exist.

Both bugs that motivated this doc had exactly this signature.
