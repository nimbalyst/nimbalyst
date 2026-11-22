# Tracker schema sharing

**A tracker is personal or it is the team's; if it is the team's, the server owns it — schema and items together — and `.nimbalyst/trackers/*.yaml` is the local copy.**

This is the reference for the sharing behavior that is implemented today. Sections marked as planned describe work that is not yet enforced by the product.

## Tracker-level configuration

Tracker schemas have one sharing axis:

```yaml
sharing: personal | team
draftByDefault: false
```

`sharing: personal` keeps the schema and every item on this machine. `sharing: team` makes the schema and the tracker's published items team-owned. `draftByDefault` applies only to team trackers: when true, a new item begins as a private draft; when false, a new item is published immediately. The parser forces `draftByDefault` to false for personal trackers.

These properties replace both `sync.mode: local | shared | hybrid` in the schema file and the separate per-machine item-sync policy. A legacy YAML file still parses, and a workspace load rewrites it to the new shape:

| Legacy schema value | Current value |
| --- | --- |
| `sync.mode: local` | `sharing: personal`, `draftByDefault: false` |
| `sync.mode: shared` | `sharing: team`, `draftByDefault: false` |
| `sync.mode: hybrid` | `sharing: team`, `draftByDefault: true` |

If the removed per-machine item policy disagrees with the legacy schema mode, the item policy wins because it governed which data people saw. The migration records that divergence, rewrites or creates the YAML representation, and then removes the old per-machine policy map.

## Draft and Published

Draft and Published are per-item states inside a team tracker. A draft remains local and private; publishing sends it to the team room. In a team tracker with `draftByDefault: false`, an item with no explicit state is published by default.

This is not a second sharing system. It is the existing per-item bit formerly used by `hybrid`, read from the legacy `shared` value or `share.status` / `share.body`, expressed in product language as Draft or Published.

Current limitation: publishing a native database-backed item is implemented, but returning an already-published native item to Draft is refused because the current room deletion path would also delete the local item. File-backed plans and decisions have a separate unpublish path that restores the local file as the authority.

The state is visible on the item detail header and in the tracker table's Publication column (column id `shared`, so saved views and typed `shared:` filter tokens keep resolving), and it is filterable by `draft` / `published`. Both surfaces render the same `TrackerPublicationChip`, which deliberately reuses `TrackerOwnershipChip`'s visual grammar. Publishing is one action: the detail header's Publish button, or `tracker_update({ id, published: true })`. Publish is offered on any Draft item of a team tracker, not only where `draftByDefault` is set — an item can be a draft in a tracker that otherwise publishes immediately.

## Numbering

Personal items and drafts receive no **shared** issue key. They do receive a machine-private number — `NIM.75`, prefix and dot and number — assigned by [`localKeyAllocator.ts`](../packages/electron/src/main/services/tracker/localKeyAllocator.ts) with no server round-trip. The dot is the whole distinction: a room prefix is two to five uppercase letters, so `NIM.75` and `NIM-75` can never be confused, and the private one fails loudly instead of resolving to someone else's item.

A local number is real, stable, and never reissued, so it is safe to hold. It is **not** safe to share: the same value in another project on the same machine, or on a colleague's machine, is a different item. Agents and the CLI are told this every time they are handed one.

Numbering runs in two places. `ElectronDocumentService.assignLocalKeysFrom` numbers rows a list or create has already read — cheap, and nothing in the steady state. [`ensureWorkspaceLocalNumbers`](../packages/electron/src/main/services/tracker/ensureWorkspaceLocalNumbers.ts) sweeps the whole workspace once per process at window open. That sweep is deliberately a **sibling** of `initializeTrackerSync`, not a step inside it: that function returns early when there is no team, which is precisely the workspace whose items will only ever have a local number.

On publication, or when existing items are published as part of personal-to-team tracker promotion, the server-side TrackerRoom assigns the issue number and key. Clients no longer allocate a provisional key. Every tracker type in the same room draws from that room's one prefix and monotonically advancing sequence, so Bugs, Features, Plans, and other team trackers in the same shared project do not have separate number ranges.

Once the room has assigned an item a key, later updates and tombstones preserve it. A client-supplied legacy key on an item's first write to the room is not preserved: it raises the room's sequence floor, but the room assigns a fresh key. This prevents two machines from making different keys authoritative for the same shared item.

The issue number sequence remains per shared project room. Prefixes are unique across an organization's projects: the organization-scoped TeamRoom atomically reserves each prefix in its project registry before a TrackerRoom can mint a new key. Fresh projects derive a prefix from their name and receive an explicit alphabetic disambiguation when the base is occupied. An explicit taken prefix is rejected with the conflicting project and a suggested free alternative.

Existing keys are immutable. When a room that predates prefix reservations claims a prefix already held by another project, the server reports the collision and leaves every existing key unchanged. That room may continue updating already-keyed items, but it cannot mint another key until a user assigns a free prefix.

`issueKeyStatus` has three values, and every surface — the tracker grid, the agent tools, and `nim --json` — reports the same one:

| Value | Meaning | What the reader is told |
| --- | --- | --- |
| `assigned` | a key the room owns | nothing further; it resolves for everyone |
| `local` | this machine's private number | it is not a shared key; keep it out of commit messages |
| `unassigned` | a team draft waiting on the room | "This item has no key until it is published." |

An unkeyed draft reads as normal, not as a failure, and the internal row ID is never dressed up as a key. The `local` value exists because collapsing it into `unassigned` was a lie with consequences: it sent agents to a publish action that a personal tracker refuses outright, and told a team-less workspace that a key was still pending when nothing would ever mint one (#1346, #1243). Where no room exists at all, the message says so rather than advising publication.

The four sentences live in [`trackerLifecycle.ts`](../packages/runtime/src/plugins/TrackerPlugin/models/trackerLifecycle.ts) and nowhere else; the CLI carries a marked vendored copy because it cannot import the runtime. `reconcileIssueKeyOnPublish` in the same module is the client-side statement of the invariant: a key is minted once at publication and an existing one is kept, so re-publishing or sweeping an already-published item during promotion can never consume a second number.

## Promotion and archiving

Promotion (`sharing: personal` -> `team`) is one-way. It asks for confirmation, then publishes every existing item, which is when those items receive their keys. There is deliberately no demotion path: taking a team tracker back to personal would strand teammates' items.

Archiving is the answer to "we should stop using this tracker". `archived: true` on the tracker schema retains every item: they stay visible and searchable and every issue key keeps resolving. Read-only is the sole consequence — item edits and new items are refused, nothing is deleted, and it can be undone by unarchiving. `resolveTrackerWriteAccess` is the one rule; `useTrackerRows`'s `isItemEditable` is the chokepoint the table, kanban, bulk edits and the row context menu share.

Both operations run through the same `tracker_define_type` path the agent tools use ([`trackerLifecycleService.ts`](../packages/electron/src/main/services/tracker/trackerLifecycleService.ts) over `tracker-lifecycle:*` IPC), so the UI and an agent cannot disagree about what promotion does. The lifecycle service merges the tracker's existing schema patch before writing, since the patch file is written whole.

## Additive and destructive schema changes

The classifier in [`packages/runtime/src/plugins/TrackerPlugin/models/trackerSchemaChangeClassifier.ts`](../packages/runtime/src/plugins/TrackerPlugin/models/trackerSchemaChangeClassifier.ts) divides data-bearing changes into three results: none, additive, or destructive. It only calls a change additive when it can prove the new schema accepts everything the old schema accepted; unknown cases default to destructive.

Additive changes include adding a field, status, or select option and widening a supported constraint. Destructive changes include removing a field, status, or option; changing a field type; narrowing a constraint; changing unclassified data-bearing field wiring; or changing which field owns the workflow-status role. A remove-plus-add is reported as destructive with possible rename candidates rather than guessed to be a rename.

Additive changes are safe because item storage is schema-tolerant. The item path carries the complete generic field bag, merges individual edits into existing data, and does not filter values through the client's current schema. An older client therefore preserves an unknown field value byte-for-byte at the field-value level when it edits a known field; this is a data-preservation guarantee, not a promise to retain the raw JSON container's whitespace or key order. Rendering iterates the schema, so the unknown field simply remains invisible until that client receives a schema that declares it; unknown status values are retained and appended to the rendered columns instead of being repaired or rejected.

### The gate

`resolveTrackerSchemaChangeGate` in the same module is the single statement of the rule, and every write path calls it:

| Verdict | Personal tracker | Team tracker |
| --- | --- | --- |
| none / additive | applies instantly | applies instantly, for any member |
| destructive | confirmation | confirmation **and** a team admin (D3) |

Additive changes deliberately carry no role check and no dialog, and the blast radius is not even computed for them — that path costs one classification and no query.

A destructive change is priced first: `evaluateTrackerSchemaChange` ([`trackerSchemaChangeGuard.ts`](../packages/electron/src/main/services/tracker/trackerSchemaChangeGuard.ts)) reads the workspace's items **once** and counts every change against those rows, producing a sentence like *"7 items have `severity`; 3 are in `blocked`."* Counting flattens both custom-field storage shapes (top-level and nested under `customFields`), because a synced item stores them nested.

The offered actions are **retire** and, when the classifier surfaced a rename candidate, **rename** — presented first, because a remove-plus-add is indistinguishable from a rename without stated intent. Neither deletes data: retiring a field removes it from the schema and the store keeps every value, which is what the storage layer does naturally. There is deliberately no "delete the values" action.

Where the rule is enforced:

- `upsertWorkspaceTrackerSchema` / `upsertWorkspaceTrackerSchemaPatch` and `resetWorkspaceTrackerSchemaOverride` gate before anything touches disk, throwing `TrackerSchemaChangeBlockedError`. `tracker_delete_type` with `resetOverride: true` — which resets the type **team-wide** — goes through the same gate.
- The agent tools take `confirmDestructive`. A tool call cannot show a modal, so the first call is refused with the blast radius and the options; the agent shows that to the user and retries. The flag is not a way past D3: a non-admin on a team tracker is refused whatever it is set to.
- The settings panel previews over `tracker-schema:preview-change` and shows the confirm before writing.
- A hand edit of the YAML arrives after the file is already saved, so no confirmation is possible. For a personal tracker it applies unchanged. For a team tracker, an admin's edit applies and its blast radius is logged; a member's destructive edit is refused — their version is preserved as a `.bak` and the team's copy is written back over the file.

Both sides of a comparison are normalized through the same serialize/parse round trip **and** `ensureTagsSupport` before classification. Skipping either makes an ordinary edit read as a removal, because the registry's model always carries the injected `tags` field that a freshly parsed file does not.

### Where D3 is actually enforced

Everything above runs in the client, so it is a UX affordance, not a security control: it prices the change, shows the confirmation, and refuses before anything reaches disk. A modified client skips all of it by speaking `trackerSchemaMutation` to the room directly.

The enforcement point for a team tracker is the **TrackerRoom**. Team custody is server-managed — the client holds no key and sends the model as plaintext JSON, which the room encrypts at rest — so the room can read both the schema it already holds and the one being pushed, and decide for itself. It escalates to an admin check when it can see that the change removes something:

| Change | Server verdict |
| --- | --- |
| Adding a field, status or select option; widening a select | additive — any member with project write access |
| A tombstone (deleting the type) | destructive — admin only |
| A field that disappears, or is renamed (which reaches the wire as remove-plus-add) | destructive — admin only |
| A field whose type changes; a select option that disappears | destructive — admin only |
| A semantic role dropped or repointed at another field | destructive — admin only |
| A payload the room cannot read | destructive — admin only |

"Admin" is resolved through the org-scoped TeamRoom from the team JWT the connection presented: an org owner or admin, or an explicit `project-admin` grant on this project. The seeded grant for a plain member is `project-editor`, so members and viewers are refused. The check fails closed — a TeamRoom lookup that errors denies.

What the server does **not** enforce is the constraint-level half of the client classifier: narrowing `maxLength`, `min`/`max`, or tightening `required`. Those are still client-guarded only. They cannot remove a teammate's stored value — item storage is schema-tolerant — but they can make an existing value fail a later validation. Widen `trackerSchemaAuthority.ts` in the collab repo rather than adding a client-declared "this change is additive" flag; a flag is forgeable and would make the gate decorative.

Renaming a project's issue-key prefix is admin-only on the same reasoning: it is one prefix per project, it changes every future issue key, and it releases the old prefix for another project to claim. The automatic first claim a fresh room makes on any member's first sync is not gated — requiring an admin there would leave a project unable to mint keys until one happened to connect.

## `.nimbalyst/trackers/*.yaml`

The `.nimbalyst/` directory is gitignored by default, so tracker YAML files are normally machine-local working files rather than a schema distribution channel.

For a personal tracker, the YAML is the local authority. For a team tracker, the server definition is authoritative and the YAML is a writable local projection. The app writes the server definition to the file and records that projected model as a baseline. A later file-watcher event loads the edit locally, diffs it against that baseline, and marks the database mirror `pending` so the schema outbox sends it to the team. This is the #1178 correction: an intentional edit no longer silently evaporates.

A team-owned edit is loaded into the local registry before the pending server write is acknowledged. If the app is offline, the edit remains loaded locally and queued; the current code does not pin the runtime to the last accepted server schema while the edit waits.

Deleting a team-owned YAML file does not delete the team's tracker; explicit team schema deletion uses the schema sync tombstone path. Current gap: the unlink handler keeps the row's existing projection baseline, so it does not immediately recreate the missing YAML file. A later accepted server schema delta resets the baseline and writes the file again.

## Gotchas and incomplete ownership surfaces

- The #1178 startup protection depends on the schema watcher's `ignoreInitial: true`. The startup directory read does not enter the watcher edit path, so a stale checked-in YAML cannot push itself merely because the app launched. Removing `ignoreInitial: true` would turn every existing file into an apparent post-baseline edit.
- A `git checkout` that restores an old team-owned YAML while the app is running does produce a watcher event. The app treats that event as deliberate, diffs the restored file against the server baseline, and queues it for the team. Detecting a git-tracked team schema and warning about this risk is planned, not yet implemented.
- The YAML ownership banner, schema activity trail, ownership UI, and explicit agent-tool ownership reporting are planned or in flight. Do not assume the current file or agent result identifies the owning team or last editor.
- Choosing "rename" records the stated intent (so the change stops reading as a removal) but does not move item values onto the new field name. The values are kept, under the old name, until a migration path exists.
- A refused hand edit is only visible in the file itself and in `main.log`; there is no notification.

## Implementation pointers

- Sharing shape and legacy YAML parsing: [`TrackerDataModel.ts`](../packages/runtime/src/plugins/TrackerPlugin/models/TrackerDataModel.ts) and [`YAMLParser.ts`](../packages/runtime/src/plugins/TrackerPlugin/models/YAMLParser.ts)
- Legacy per-machine policy migration and Draft/Published compatibility: [`TrackerPolicyService.ts`](../packages/electron/src/main/services/TrackerPolicyService.ts)
- Team schema ownership, baseline diffing, and the pending outbox: [`trackerTypeDefStore.ts`](../packages/electron/src/main/services/tracker/trackerTypeDefStore.ts)
- YAML projection and watcher behavior: [`TrackerSchemaService.ts`](../packages/electron/src/main/services/TrackerSchemaService.ts)
- Baseline column rationale: [`0030_tracker_type_defs_synced_model.sql`](../packages/electron/src/main/database/sqlite/schemas/0030_tracker_type_defs_synced_model.sql)

## Legacy organization recovery

[In-place organization recovery](LEGACY_ORG_RECOVERY.md) restores reviewed schemas, shared navigation, saved views, item payloads, and bodies under their existing project and item identities. It uses a separate admin import while normal writes are durably paused. It preserves reserved keys, including locally assigned shared keys that never uploaded, and advances the allocator above both existing identities and its stored floor. Private items and unpublished drafts are not promoted. Schema and content conflicts block readiness. Older queued item edits cannot overwrite the recovered baseline: they remain in the local transaction history for review. Normal first-publication allocation rules are unchanged.
