# Codex Pre-Edit Tracking — Investigation State

Status: **STUCK**. Three approaches tried, none reliably solves the pre-edit race for `update`-kind file_change items. This doc captures everything learned so the next session can pick up cleanly without re-deriving.

Tracker: **NIM-586** ("Codex sessions miss post-edit snapshot; sidebar diff peek uses git instead of session history") — the part about post-edit snapshots is solved. The pre-edit race for updates is still open.

## The user-visible problem

In the **FilesEditedSidebar peek popover**, AI-edited files render as all-green (entire file looks added) instead of a real red-green diff. Reproduces 100% for any file the AI touches that is:

- gitignored (e.g. anything under `/tests/` in this repo)
- untracked in git
- brand-new in a worktree

The peek calls `git:file-diff` with `group: 'working'` (see `FilesEditedSidebar.tsx:162-170`). For files not in HEAD, the handler falls through to `git diff --no-index -- /dev/null <file>` which produces an all-added unified diff. See `GitHandlers.ts:879-905`.

## What we shipped this session (works, do not regress)

### 1. Codex SDK upgrade 0.128.0 → 0.130.0

- Bumped in `packages/runtime/package.json:206` and `packages/electron/package.json:61`
- npm lockfile had to be manually patched: 16 codex-related entries under `packages/electron/node_modules/@openai/` and `packages/runtime/node_modules/@openai/` were stale. Deleted those entries via a Node script, ran `npm install`, codex-sdk hoisted to root `node_modules/@openai/codex-sdk@0.130.0`.
- Verified native binary present at `node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin`
- `peer: true` count unchanged (17 → 17)

### 2. Post-edit snapshot pipeline (NIM-586 part 1)

Codex's `file_change` `item.completed` now triggers a `post_edit_snapshot` chunk that writes an `ai-edit` history row tagged with `sessionId` in metadata. Mirrors Claude's `AgentToolHooks.createTurnEndSnapshots`.

- `StreamChunk.type` extended with `'post_edit_snapshot'` in `packages/runtime/src/ai/server/types.ts:388, 460-477`
- `OpenAICodexProvider.maybeBuildFileChangePostEditSnapshot` at `OpenAICodexProvider.ts:~2110` — fires on `item.completed` for `file_change`, reads each affected path from disk, reuses the synthetic edit-group ID via `lookupCodexEditGroupId`, skips `delete` kinds.
- Yielded in main loop at `OpenAICodexProvider.ts:~1010` right after pre-edit yield, wrapped in try/catch.
- Handler in `MessageStreamingHandler.ts:~1329` writes via `historyManager.createSnapshot(absPath, content, 'ai-edit', desc, { sessionId, toolUseId })`.
- Verified: 3 pre-edit + 3 ai-edit rows landed for test session, all stamped with same `toolUseId = nimtc|item_15|...`

### 3. Session-aware diff IPC (NIM-586 part 2)

`session:file-diff(workspacePath, sessionId, filePath)` IPC handler synthesizes a unified diff from pre-edit baseline (red) vs ai-edit snapshot (green), falling back to current disk if no `ai-edit` snapshot exists. Returns `{ unifiedDiff, isBinary, source }`.

- Handler at `packages/electron/src/main/ipc/SessionFileHandlers.ts:~221`
- New helper `historyManager.getLatestSnapshotContent(filePath, sessionId, snapshotType)` at `HistoryManager.ts:~1163`
- `FilesEditedSidebar.handleGetDiff` (`FilesEditedSidebar.tsx:162-191`) tries the session-aware IPC first when `activeSessionId` is set; falls back to `git:file-diff` if no session baseline exists.
- Verified via `renderer_eval`: returns 398-byte unified diff for a `change-tracking-codex-test.md` (new file) with `source: 'session-history'`.

### 4. Codex PreToolUse hook plumbing (LOADED BUT NOT WORKING)

All the wiring is in place but **codex is not honoring the inline `--config hooks.PreToolUse=[{...}]` override**. Evidence: `[CODEX] PreToolUse hook configured` log fires at session start (confirming resolver returns valid path and config-builder runs), but the sidecar dir is never created (confirming the hook subprocess never runs).

Files involved:

- `packages/electron/resources/codex-pre-edit-hook.mjs` — Node script. Reads stdin payload, extracts paths from apply_patch DSL (`*** Add/Update/Delete File:`), snapshots each path's content to `<NIMBALYST_PRE_EDIT_DIR>/<sha1(path)>.json`. Always emits `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}`. **Verified working when invoked directly via `ELECTRON_RUN_AS_NODE=1 <electron> <hook.mjs>` with stdin payload.**
- `packages/electron/src/main/services/ai/codexPreEditHookPath.ts` — resolves the script path in dev (via `getPackageRoot() + resources/`) and packaged (via `process.resourcesPath`).
- `packages/electron/src/main/index.ts:~1429` — registers `OpenAICodexProvider.setPreEditHookScriptPathResolver(resolveCodexPreEditHookScriptPath)` and `setPreEditSidecarDirResolver(sessionId => userData/codex-pre-edit-snapshots/<safeId>)`.
- `OpenAICodexProvider.ts`:
  - New static fields `preEditHookScriptPathResolver` and `preEditSidecarDirResolver` plus setters
  - `buildCodexConfigOverrides` injects `configOverrides.hooks = { PreToolUse: [{ matcher: '^apply_patch$', hooks: [{ type: 'command', command: '"<execPath>" "<hookPath>"' }] }] }`
  - `sendMessage` adds `NIMBALYST_PRE_EDIT_DIR` and `ELECTRON_RUN_AS_NODE=1` to `codexEnv` per session
  - `maybeBuildFileChangePreEditSnapshot` reads from sidecar (`<dir>/<sha1(path)>.json`) before falling back to disk-read
- `packages/electron/package.json` — added `resources/codex-pre-edit-hook.mjs` to `extraResources`

## The pre-edit race (the actual bug)

Codex's apply_patch emits `item.started` for `file_change` **at the same time or slightly after** it applies the patch to disk. When `OpenAICodexProvider.maybeBuildFileChangePreEditSnapshot` does `fs.readFileSync(filePath)` at `item.started` time, the read often captures **post-edit** content because the patch already wrote.

The host's existing fallback (use `FileSnapshotCache` from `HooklessAgentFileWatcher`) only helps when chokidar had time to seed the cache. For freshly-spawned sessions (`spawn_session` workflow), the cache is empty when the first edit fires, so it falls through to the racey disk read.

### Observed data

For test session `dfaed934-117f-4fb5-bc26-6d40877dd133` (post-edit snapshot working, but pre-edit raced):

| file | pre-edit MD5 | ai-edit MD5 | identical? |
|---|---|---|---|
| change-tracking-note.md | 4d43...352a | 2b6a...b40e | no (lucky timing — small file, fired first) |
| fruits.md | c79e...aa51 | c79e...aa51 | **YES (race hit)** |

For session `801a2eb4-e3a4-45a7-8e63-1f6822219d77` (after hook plumbing landed):

| file | pre-edit MD5 | ai-edit MD5 | identical? |
|---|---|---|---|
| change-tracking-note.md | 2b6a...b40e | 4a18...6991 | no |
| fruits.md | 3dcb...7988 | 3dcb...7988 | **YES (race STILL hit)** |
| sidecar dir | N/A | N/A | **does not exist** — hook never ran |

Bottom line: **the hook never fired**, so my pre-edit pipeline still reads disk and still races for fruits.md.

## Why the hook didn't fire (hypothesis)

The codex CLI loads hooks from `$CODEX_HOME/hooks.json` or `[hooks.PreToolUse]` arrays in `$CODEX_HOME/config.toml` and project-level `.codex/config.toml`. The SDK's `serializeConfigOverrides` (`@openai/codex-sdk/dist/index.js`) flattens config objects to `--config key=value` overrides like:

```
--config hooks.PreToolUse=[{matcher = "^apply_patch$", hooks = [{type = "command", command = "..."}]}]
```

**Hypothesis**: codex CLI parses `--config` overrides but its hooks-loading layer (`codex_hooks` crate, see `codex-rs/hooks/`) reads from the file-system layers (user, project, requirements) and **may not merge `--config` overrides into that layer**. Evidence:

- All hooks integration tests in codex-rs/core/tests/suite/hooks.rs write hooks via `fs::write(home.join("hooks.json"), ...)` — never via CLI overrides
- The `config_loader_tests.rs` test for `[[hooks.PreToolUse]]` writes to `config.toml` and asserts `layer.config.get("hooks")` — but that's the user layer, not CLI overrides

This needs to be confirmed by reading codex-rs source. If confirmed, **the hook must be configured via a file**, not `--config`.

## The "awful design choice" — why CODEX_HOME override sucks

Setting `CODEX_HOME=<our_per_session_dir>` would let us drop a `hooks.json` and codex would load it. **But** that breaks the user's CLI codex experience because:

- `~/.codex/auth.toml` (the user's logged-in account) would not be visible
- `~/.codex/sessions/` (the user's chat history) would not be visible
- Any user-configured hooks, MCP servers, plugins would be invisible

Workarounds (all suboptimal):

1. **Copy/symlink user's CODEX_HOME contents** into per-session dir. Adds disk overhead per session. Fragile (auth.toml refresh races, symlink resolution).
2. **Project-level `<workspace>/.codex/config.toml`**. Adds a file to the user's repo (gitignore via `.codex/`). Persistent on disk between sessions unless cleaned up. Could clash with the user's own project-level hooks.
3. **Patch the user's `~/.codex/config.toml` to add our hook**. Pollutes user config. Cleanup is fragile.

None of these is good. **A clean fix requires codex itself to honor hooks via `--config` overrides or expose a `--hooks-file` CLI arg.** Could be an upstream feature request to openai/codex.

## NEW LEADS (2026-05-14 session) — what changes the picture

Spent a session reverse-engineering the packaged `codex` binary (strings dump + `app-server generate-json-schema`). Found several things the prior investigation missed.

### Lead 1 — The app-server protocol exposes the patch diff text directly

`codex app-server --listen stdio://` (an experimental codex subcommand the SDK does NOT use) speaks a JSON-RPC v2 protocol with much richer notifications than `codex exec --experimental-json`. Critically:

- **`item/fileChange/patchUpdated`** notification carries `changes[].diff` — the **full unified-diff text** that's about to be (or has just been) applied for each affected path. See `/tmp/codex-schema/v2/FileChangePatchUpdatedNotification.json`.
- The exec mode strips this — the SDK's `FileChangeItem` only has `{path, kind}`.

This is the unlock. With the diff text in hand, we can compute pre-edit content **deterministically** by reverse-applying the diff against the post-edit disk content — no hook, no race, no FileSnapshotCache dependency. For `add` kinds the pre-edit is "did not exist". For `delete` and `update` kinds the diff contains both `-` and `+` lines.

### Lead 2 — Hooks have a trust system; `--config` hooks are likely untrusted by default

The `HookTrustStatus` enum is `managed | untrusted | trusted | modified` (see `/tmp/codex-schema/v2/HooksListResponse.json`, definitions section). Hooks have a `source` of `system | user | project | mdm | sessionFlags | plugin | cloudRequirements | legacyManagedConfigFile | legacyManagedConfigMdm | unknown`. **Hooks injected via `--config hooks.PreToolUse=[...]` get `source = sessionFlags`** and almost certainly default to `untrusted`. Untrusted hooks in headless `exec` mode silently no-op (the TUI prompts the user — there is no prompt in exec).

Evidence: binary contains the string `Failed to trust hook: ` and PR #21755 is titled "Improve hooks trust flow in TUI". The `HookMetadata.trustStatus` field is required; `isManaged` is required and only `managed` source bypasses the trust dance.

So the prior conclusion ("codex doesn't honor `--config` hooks") is probably wrong — codex **parses** them, then refuses to execute them because they're untrusted in non-interactive mode.

### Lead 3 — `apply_patch_streaming_events` feature flag exists but is "under development"

From `codex features list`:

```
apply_patch_streaming_events            under development  false
```

If this is wired to the exec mode JSON output, enabling it via `--config features.apply_patch_streaming_events=true` (or `--enable apply_patch_streaming_events`) might cause `codex exec --experimental-json` to start emitting `item.started` + diff content before the on-disk write. **Cheapest experiment of the lot — single flag toggle.** May not be plumbed for exec yet; only one way to find out.

### Lead 4 — `--ignore-user-config` is a real flag, but doesn't help us

`codex exec --ignore-user-config` skips `$CODEX_HOME/config.toml` while still reading `$CODEX_HOME/auth.toml`. Doesn't let us layer our hooks file on top of the user's config cleanly — config.toml is all-or-nothing.

### Lead 5 — `plugin_hooks` is a separate "under development" feature

Plugins are stable; `plugin_hooks` is "under development". The plugin system has a scaffolding tool (`codex plugin marketplace`) with `--with-hooks` flag. A codex plugin can register hooks via a `hooks/` directory and a `hooks.json` manifest. **Plugins from a known marketplace path may be treated as `trusted` by default** (sources `plugin` and `legacyManagedConfigFile` exist as distinct from `sessionFlags`).

Less explored than the others.

## Recommended order to try the new leads

1. **Smallest experiment: `--enable apply_patch_streaming_events`** in our existing OpenAICodexProvider. If the exec JSON stream starts including diff text per `item.updated` or pre-`item.completed` events, the whole hooks rabbit hole is moot.

2. **Mid-size fix: switch from `codex exec` to `codex app-server` (stdio)** and consume `item/fileChange/patchUpdated` directly. This is the **most reliable** path — race-free by construction, no hooks, no trust dance. Tradeoff: requires writing our own JSON-RPC v2 client (the codex-sdk only speaks exec). The `codex app-server generate-ts` subcommand can generate TypeScript bindings for us. Likely 1–2 days of work but eliminates the whole class of bugs.

3. **Trust-state workaround**: locate where codex persists `currentHash` + `trustStatus` for hooks (likely `$CODEX_HOME/hook_state.json` or under a `hooks/` subdir based on the schema fields). Pre-write a trust record for our `sessionFlags` hook so it executes. Brittle — codex could change the format — but might be a 1-hour fix.

4. **Plugin path**: package our hook as a codex plugin and reference it via `--config plugins.local_path=...` (or whatever the config key is — would need to grep the binary). If plugins from a local path are auto-trusted, this is cleaner than the trust workaround.

## Why the diff-reverse approach (lead 1+2) is the right end state

- **Deterministic**: pre-edit = patch.reverse(post-edit content). No I/O race.
- **Works for any kind**: add (pre = empty), update (reverse hunks), delete (pre = `-` lines from patch).
- **No host-side hook subprocess**: less moving parts, no env plumbing, no sidecar dirs.
- **Composable with post-edit snapshot we already ship**: post-edit snapshot is already correct; reverse-applied diff gives pre-edit.
- **No upstream dependency on codex hooks-via-CLI**: stops blocking us on whatever codex does or doesn't do with `--config hooks`.

The only reason to keep the hook plumbing alive is if app-server migration is judged too expensive; in that case lead 3 (trust workaround) is the fallback.

## Alternatives the prior session listed (kept for reference, mostly superseded)

1. **Test `--config hooks.PreToolUse=[{...}]` directly via codex CLI** to definitively confirm it's ignored. Run `codex exec --config 'hooks.PreToolUse=[{matcher = "^apply_patch$", hooks = [{type = "command", command = "echo hello > /tmp/hook-ran"}]}]' ...` and see if `/tmp/hook-ran` appears.
2. **Use codex's `--config` to point at a hook file**. Maybe codex supports something like `--config hooks_file=/path/to/hooks.json` even when CLI override of inline hooks is rejected. Worth grepping codex source.
3. **Open a codex GitHub issue/PR to support `--config hooks.PreToolUse` overrides**. See related PRs:
   - #18391 — fix(core): emit hooks for apply_patch edits (April 22)
   - #20692 — Support PreToolUse additionalContext (May 5)
   - #20527 — Support PreToolUse updatedInput rewrites (May 12)
   - #21755 — Improve hooks trust flow in TUI (May 9)
4. **Synchronously read from disk BEFORE codex applies the patch using a different signal** — but `item.started` IS the synchronous signal and it races. There may not be an earlier signal.
5. **Use the FileSnapshotCache MORE aggressively** — pre-warm it on session creation by scanning the workspace. Expensive for large repos, but correct. Could be limited to `git ls-files` output for tracked files (won't help gitignored).
6. **Tee codex's stdin/stdout/stderr** to intercept the apply_patch arguments and snapshot before forwarding the call. Requires SDK-internal hooks or wrapping the binary. Brittle.
7. **Watch the kernel's file-write events via fsevents/fanotify with sub-millisecond precision** to capture the moment before write. Cross-platform nightmare.

## Files modified in this set of sessions (uncommitted)

- `package-lock.json` (codex-sdk 0.128.0 → 0.130.0; ~1300 line diff)
- `packages/electron/package.json` (codex-sdk bump + extraResources entry for hook script)
- `packages/runtime/package.json` (codex-sdk bump)
- `packages/runtime/src/ai/server/types.ts` (added `'post_edit_snapshot'` to `StreamChunk.type` and `postEditSnapshot` field)
- `packages/runtime/src/ai/server/providers/OpenAICodexProvider.ts`:
  - Added `maybeBuildFileChangePostEditSnapshot` method
  - Added two static resolver fields + setters (`preEditHookScriptPathResolver`, `preEditSidecarDirResolver`)
  - `buildCodexConfigOverrides` now injects `hooks.PreToolUse` when resolver returns a path
  - `sendMessage` now layers `NIMBALYST_PRE_EDIT_DIR` and `ELECTRON_RUN_AS_NODE=1` into codexEnv per session
  - `maybeBuildFileChangePreEditSnapshot` reads sidecar first, deletes after consuming, falls back to disk
  - Diagnostic logs at config-build and env-build time
- `packages/electron/src/main/services/ai/MessageStreamingHandler.ts` — added `case 'post_edit_snapshot'` that writes via `historyManager.createSnapshot(absPath, content, 'ai-edit', desc, { sessionId, toolUseId })`
- `packages/electron/src/main/HistoryManager.ts` — added `getLatestSnapshotContent(filePath, sessionId, type)` helper
- `packages/electron/src/main/ipc/SessionFileHandlers.ts` — added `session:file-diff` IPC handler, imports `fs.promises`, `diff.createPatch`, `historyManager`
- `packages/electron/src/main/services/ai/codexPreEditHookPath.ts` (new) — resolver for the hook script path
- `packages/electron/src/main/index.ts` — added import + setter calls for hook resolver and sidecar dir resolver
- `packages/electron/src/renderer/components/AgentMode/FilesEditedSidebar.tsx` — `handleGetDiff` now tries `session:file-diff` first, falls back to `git:file-diff`
- `packages/electron/resources/codex-pre-edit-hook.mjs` (new) — the hook script itself

## Key learnings / gotchas

- **`item.started` for `file_change` races with apply_patch on disk.** This is documented in the existing code: `MessageStreamingHandler.ts:1252-1261`. The existing FileSnapshotCache fallback works for files chokidar has seen but fails for freshly-spawned sessions.
- **Same session, two file edits in one patch — second one races more than first.** Observed: note.md (smaller, fired first) captured correct pre-edit; fruits.md (later in same item.started) captured post-edit. Suggests the race is wall-clock-time-based — codex finishes writing one file before our handler reads the second.
- **Codex SDK serializes nested config to `--config key=value` overrides** via `serializeConfigOverrides` in `@openai/codex-sdk/dist/index.js`. Arrays become inline TOML literals like `[{matcher = "...", hooks = [...]}]`. The SDK should handle our `hooks` object correctly *if codex's hook layer honors CLI overrides*.
- **`ELECTRON_RUN_AS_NODE=1` lets `process.execPath` run as plain Node**, avoiding the need for system Node. The electron binary is at `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron` in dev, and at the packaged binary location in packaged builds.
- **`CodexOptions.env` REPLACES `process.env` entirely** (not merge). Whoever sets it must include PATH and everything else. We layer onto `buildCodexEnvironment()`'s output for safety.
- **PR #20540 (apply_patch as TurnItem) lands `item.started` BEFORE writing**, per the PR body. But in practice the events are emitted via async streaming that lets the disk write win the race.
- **`replaceSpeculative: true` on `createTag`** lets later pre-edit captures overwrite earlier ones for the same file in the same session. The current pre-edit pipeline relies on this to handle the multi-patch-per-turn case.
- **Codex codes file_change kind as `'add' | 'update' | 'delete'`** (not 'create' / 'remove'). My hook script's regex handles all variants defensively.

## State to clean up before next session

The current workstream has uncommitted changes across many files. Nothing has been committed. The next session should decide:

1. Whether to revert the hook plumbing (since it doesn't work) or leave it dormant pending a fix
2. Whether to commit the working pieces (SDK upgrade, post-edit snapshot, session-aware diff IPC) as a standalone NIM-586 fix and tackle the pre-edit race separately
3. Whether to file an upstream issue at openai/codex requesting `--config` support for hooks

## What I'd do next if I were sane

1. **First, definitively test whether codex `--config hooks.PreToolUse=[...]` is honored.** Open a shell:
   ```bash
   echo '*** Begin Patch
   *** Add File: /tmp/codex-test.md
   +hello
   *** End Patch' | codex exec --config 'hooks.PreToolUse=[{matcher = "^apply_patch$", hooks = [{type = "command", command = "touch /tmp/hook-ran"}]}]' apply_patch
   ```
   If `/tmp/hook-ran` appears → CLI overrides DO honor hooks, and my issue is something else (maybe TOML serialization quoting). If not → confirmed CLI overrides don't honor hooks, and the file-based path is the only way.

2. **If CLI overrides don't work, switch to a per-session config file** without polluting user's CODEX_HOME. Cleanest path: write a project-level `<workspace>/.codex/config.toml` with the hook, with cleanup logic to remove it after session ends. Add `.codex/` to a recommended gitignore.

3. **Alternative cleaner path: file an upstream issue** at openai/codex asking for `--hooks-file <path>` support, or for `--config hooks.PreToolUse` to merge into the hooks layer. The team is actively working on hooks (multiple PRs in April-May 2026), so this is reasonable to ask for.

4. **Commit the working parts of NIM-586** (post-edit snapshot, session-aware diff IPC) so the user has at least *some* improvement in the meantime. Even with a racey pre-edit, the post-edit ai-edit row gives the chat-transcript diff a stable "after" reference, and for new-file creates the sidebar peek now works correctly.
