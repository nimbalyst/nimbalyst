# Recover a legacy organization in place

Organization owners and admins can recover supported legacy team content from **Settings > Security & Encryption > Recover this organization**. Recovery preserves the organization and project bindings, stable object IDs, and reviewed ticket assignments. It does not move the project to a new organization. Use a version of both the desktop app and sync server that includes this recovery flow; a deployed rollout is separate from implementing it.

## Before starting

Keep every device's local data and backups. Update participating clients, sign in to the affected team as an owner or admin, and keep a second authenticated Nimbalyst installation available for independent verification. A single-admin organization can use the same administrator account on both installations. The server requires verification from a different signed-in session than the one that started recovery; it checks the session, not the device, so signing out and back in on the same installation also counts as a different session.

Inspection reads the exact selected organization, raw custody marker, key availability, project registry, and current server inventory. A failed key probe, malformed response, or unavailable service is not evidence of legacy encryption. Repair or retry those failures before proceeding. Normal clients never fall back to retired client encryption.

## Collect and review sources

1. Inspect the organization. Collect sources from each folder linked to its projects. Collection uses the running application's read-only database and replica access, includes previously synced and pending shared items, and excludes private items and unpublished drafts.
2. Enter a passphrase of at least 16 characters and save an encrypted `.nimrecovery` bundle. Keep the passphrase separately. The passphrase is used only to save, import, restore and verify. Saving writes a new file and decrypts it again to verify the copy. The suggested filename includes a timestamp; an existing filename is refused even if the save dialog offers to replace it. Repeated attachment and document bytes are stored once, and the size limit is checked before the save dialog opens.
3. For missing sources, collect and save a bundle on another authorized device, then import it into the reviewing installation. This can contribute plaintext recovered using that device's retained historical keys without transferring the keys. Save the combined bundle again before starting.
4. Review every ticket assignment and the source blockers. Conflicting identities or current content, missing bodies, incomplete replicas, corrupt attachments, and unknown sharing policies block restoration. Resolve the sources and inspect again. Recovery never fills a missing body with an empty document.

A retained historical key file that cannot be read on this device is reported by name as a notice. It does not block recovery by itself; content that needed those keys still appears as a missing source.

Collected sources stay in memory only while the recovery section is open. Closing it, switching organization, signing out, or completing recovery discards them. Before starting, collect again and save a new bundle; after starting, import the saved bundle to resume. Bundles saved by earlier preview builds cannot be opened.

**Export diagnostics** saves a content-free JSON report of custody checks, source counts, blockers, and operation progress for private support escalation. It excludes source bodies, attachment bytes, local paths, credentials, and key material.

Bundles contain private organization content and preserved original ciphertext. They use authenticated encryption with a portable passphrase; never attach a bundle or passphrase to a public issue. Import verifies the organization and, for an active operation, the exact reviewed manifest. A wrong passphrase or modified file cannot authorize restoration.

## Restore and verify

Start recovery only after reviewing and saving complete sources. The server pauses ordinary writes, closes existing team content sockets, drains admitted requests, and rechecks the source revisions under durable write fences. The custody marker stays legacy until all restored content has passed independent readback. Read-only membership and access checks keep answering during the pause. Scheduled maintenance that comes due during the pause runs after the pause is released. If a content room does not finish its in-flight work within a few seconds, that step fails with a retryable error; the pause stays in place.

If sources changed before any replacement, **Recheck changed sources** can return to inspection. The server checks actual room receipts, including writes whose replies were lost, before allowing this. Once any replacement has committed, import the same saved bundle and **Resume recovery**. Closing the window, losing authorization, or a timeout never releases a partially restored operation. Another currently authorized admin can resume it.

On the second installation, open the same team's recovery settings and import the saved bundle. **Verify all content and resume sync** reads every restored current object and attachment, compares it with the saved sources, verifies identities and allocation counters, and then releases the pauses. Refresh status or reopen team views on the first installation afterward.

Current documents, tracker payloads, schemas, navigation, saved views, titles, folder relationships, and attachments retain their reviewed identities. New tickets allocate above all reserved numbers and the previous allocator floor. Original SQL rows and original attachment objects remain archived in tenant storage. Retained historical ciphertext may still be unreadable; successful current-content recovery does not mean every historical revision was decrypted.

## Queued edits and limitations

Document outboxes retain their CRDT operations; replaying operations already included in a recovered snapshot is idempotent. Recovery does not blanket-clear outboxes or mark a folder synced. A queued tracker edit based on a revision before restoration is refused as `recoveryConflict` and retained locally for review, without rolling the recovered projection back. Reopen the recovered item and reapply the intended changes. Updated clients record the pre-edit revision durably on both local database backends. Older clients cannot edit recovered items safely and must be updated.

The first implementation is bounded: at most 100 projects, 2,000 recovery content groups, 10,000 records per source room, 8 MiB for a tracker or metadata import, 12 MiB for a document import, and a 128 MiB encrypted bundle. Each original SQL archive is bounded to 20,000 rows and 8 MiB per content group. Exceeding a limit blocks recovery before replacement; it is not permission to omit content.

Recovery does not yet restore team conversations, feedback requests, or team inbox messages. While any of that content exists, review shows a blocker naming it, and both recovery and the marker-only call are refused. The inbox check probes each current member's inbox, so organizations with more than 500 members are refused; inboxes of former members are not checked.

An admin cannot use the old marker-only call to convert a populated legacy organization. That call remains valid for genuinely empty setup and idempotent server-managed calls. Personal/mobile encryption and personal organization routing are unchanged. No raw team DEK is returned by the recovery API or desktop IPC.

## Implementation references

The shared wire types are in [teamRecovery.ts](../packages/collab-protocol/src/teamRecovery.ts). [TeamRecoveryClient.ts](../packages/electron/src/main/services/TeamRecoveryClient.ts) coordinates saved sources and server checkpoints; [TeamRecoveryService.ts](../packages/electron/src/main/services/TeamRecoveryService.ts) supplies scoped authentication, native file dialogs, and read-only local sources. The server implementation lives in the sibling collab repository's `recovery*` modules. Custody refusal messages surfaced through existing sync and MCP operations direct admins to the same Security & Encryption settings.
