#!/usr/bin/env node
/**
 * Codex PreToolUse hook for Nimbalyst.
 *
 * Invoked by the Codex CLI synchronously BEFORE every apply_patch tool call.
 * Reads the patch body from stdin, extracts the affected file paths, and
 * snapshots each file's current disk content to a per-session sidecar
 * directory. The host (OpenAICodexProvider.maybeBuildFileChangePreEditSnapshot)
 * reads those sidecar entries at item.started time, sidestepping the race
 * where Codex emits item.started AFTER apply_patch has already written
 * to disk.
 *
 * Always emits `permissionDecision: "allow"` — this hook observes, it does
 * not gate. Any error (bad payload, unparseable patch, unwritable sidecar
 * dir) is swallowed and we still allow the patch through; the host falls
 * back to disk-read if no sidecar entry exists.
 *
 * Env vars expected from the parent Codex process (inherited from the
 * Nimbalyst main process via CodexOptions.env):
 *   NIMBALYST_PRE_EDIT_DIR  Absolute path to the per-session sidecar dir.
 *                           When unset, the hook is a no-op (still allows).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

function allow() {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    }) + '\n',
  );
  process.exit(0);
}

function pathHash(filePath) {
  return createHash('sha1').update(filePath).digest('hex');
}

function parseApplyPatchPaths(patchBody) {
  // apply_patch DSL recognizes:
  //   *** Add File: <path>
  //   *** Update File: <path>     (optionally followed by `*** Move to: <new>`)
  //   *** Delete File: <path>
  // We only care about the source path to snapshot pre-edit content.
  const entries = [];
  const lines = patchBody.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    const path = m[2].trim();
    if (!path) continue;
    entries.push({ kind, path });
  }
  return entries;
}

function main() {
  const dir = process.env.NIMBALYST_PRE_EDIT_DIR;
  if (!dir) {
    allow();
    return;
  }

  let payload;
  try {
    const raw = readFileSync(0, 'utf8');
    payload = JSON.parse(raw);
  } catch {
    allow();
    return;
  }

  const command =
    payload && typeof payload === 'object' && payload.tool_input && typeof payload.tool_input === 'object'
      ? payload.tool_input.command
      : undefined;
  if (typeof command !== 'string' || !command) {
    allow();
    return;
  }

  let entries;
  try {
    entries = parseApplyPatchPaths(command);
  } catch {
    allow();
    return;
  }
  if (entries.length === 0) {
    allow();
    return;
  }

  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    allow();
    return;
  }

  for (const { kind, path } of entries) {
    let content = '';
    if (kind !== 'add') {
      try {
        content = readFileSync(path, 'utf8');
      } catch {
        // File missing or unreadable — record an empty baseline so the host
        // still produces a diff (showing the patch result as all-added).
        content = '';
      }
    }
    const sidecarPath = join(dir, `${pathHash(path)}.json`);
    // Last-write-wins: when the same path is patched twice in one turn,
    // the SECOND hook fire captures the result of the first patch, which is
    // the correct "before" baseline for the second patch's diff.
    try {
      writeFileSync(
        sidecarPath,
        JSON.stringify({ path, kind, content, capturedAt: Date.now() }),
        { mode: 0o600 },
      );
    } catch {
      // Silent — failure to write doesn't justify denying the edit.
    }
  }

  allow();
}

main();
