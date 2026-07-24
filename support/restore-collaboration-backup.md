# Restore collaborative content from a local backup

Nimbalyst keeps a latest-only plaintext recovery copy of collaborative documents and tracker bodies on each desktop device that opens or explicitly backs up that content. These files are independent of the workspace database and the collaboration server.

## Security note

The recovery copies are intentionally decrypted plaintext. Anyone who can read your operating-system account's application-data folder can read them. This is necessary so an encryption-key or server migration failure cannot make the recovery copy unusable.

## Create a fresh full backup

1. Open the team's project in the desktop app.
2. Open **Settings**, then the team's **Security & encryption** section.
3. Select **Back up all now**.
4. Wait for the success message. Do not start an encryption or organization migration if any item failed.

Opening and editing a shared document or tracker body also refreshes its individual recovery copy after a short delay. That live behavior only covers content opened on this device; **Back up all now** is the complete sweep.

## Backup locations

The tree is below Electron's `userData` folder:

```text
collab-backups/<orgId>/<projectId-or-_primary>/
  manifest.json
  documents/<documentId>.<ext>
  bodies/<itemId>.md
```

Typical `userData` roots are:

- macOS: `~/Library/Application Support/@nimbalyst/electron/`
- Windows: `%APPDATA%\@nimbalyst\electron\`
- Linux: `~/.config/@nimbalyst/electron/`

`manifest.json` records the title, type, original relative path, byte size, SHA-256 hash, and backup time for each file. A project moved to another organization or project keeps its old tree as the pre-migration recovery point.

## Restore a tracker body manually

Tracker bodies are the highest-priority recovery target because they have no workspace file.

1. Find the item in `manifest.json`; its document ID is `tracker-content/<itemId>`.
2. Open `bodies/<itemId>.md` in a text editor and confirm the expected content is present.
3. Open the matching tracker item in Nimbalyst.
4. Replace its body with the recovery file's contents and save. This publishes a fresh Y.Doc update to the collaboration room.

If the tracker item cannot be opened, keep the `.md` file unchanged and contact support before making further migration attempts.

## Restore a file-backed shared document manually

1. Find the document in `manifest.json` and note its `relativePath`.
2. Copy the file from `documents/` to that relative path inside the workspace. Keep a separate copy of both versions before overwriting anything.
3. Open the shared document in Nimbalyst.
4. From the local-source actions, choose **Re-upload Local Source** and confirm the overwrite after reviewing the conflict details.

## Support-assisted room restore

The desktop main process also exposes a scoped restore operation that reads the manifest entry, applies it through the document type's collaboration adapter, and waits for the server to acknowledge the Y.Doc update:

```js
await window.electronAPI.collabBackup.restore(workspacePath, documentId)
```

Use this only while the correct workspace window is active and after preserving the existing backup tree. A successful response is `{ success: true }`; a failure leaves the recovery file untouched.

### Force-replace an undecryptable room (needs-recovery)

The scoped restore above merges the plaintext back into the live room. It deliberately **refuses** a room whose server state this device cannot decrypt (`"content this device could not decrypt"`), because merging over unreadable-but-real content would clobber it for everyone. That refusal is correct for routine restores — but the needs-recovery disaster is exactly the case where the server room *is* undecryptable and the plaintext backup is the only surviving copy.

For that case, pass `force`:

```js
await window.electronAPI.collabBackup.restore(workspacePath, documentId, true)
```

Force mode connects even when the room is undecryptable, applies the plaintext backup, and then **replaces the room's authoritative server state** with the restored content, discarding the undecryptable rows. It still refuses to replace the room with empty content, so a blank backup can never wipe a room.

Only use force after:

1. Confirming the plaintext file under `documents/` or `bodies/` holds the expected content.
2. Preserving the existing backup tree (copy it aside).
3. Verifying with the team that no member still holds a readable copy of the room — force is one-way and drops the old server rows.

A successful response is `{ success: true }`. If the server does not acknowledge the replacement, the response is a failure and the recovery file is left untouched.

## Size-guard behavior

Nimbalyst refuses to replace a non-empty recovery file with empty content or content smaller than half the current copy. This protects a good backup from a transient empty or partially initialized Y.Doc. A full sweep reports that refusal as a failure so an encryption migration cannot proceed on an unverified snapshot.
