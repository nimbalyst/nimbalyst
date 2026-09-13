# @nimbalyst/node

Run a Nimbalyst agent session from a plain Node process. No Electron, no renderer.

This is the first consumer of `@nimbalyst/runtime`'s `node` export condition. It imports only deep `node`-condition subpaths — never the `@nimbalyst/runtime` barrel, which drags in the whole Lexical editor tree and is not emitted into `dist-node/` at all.

## Build from a checkout

Run these commands from the repository root:

```sh
npm ci
npm run build:workspace-deps
npm run build:node --workspace=@nimbalyst/runtime
npm run build --workspace=@nimbalyst/node
```

The Node package builds explicitly after runtime's Node exports and declarations exist. It does not compile during installation, when those artifacts are absent in a clean checkout.

## What it does

```
nimbalyst-node --config ./nimbalyst-node.config.json \
               --workspace /path/to/repo \
               --prompt "list the files in this directory"
```

Creates (or resumes) a session, runs one Claude Code turn against the workspace, streams the output, and persists the transcript to `ai_agent_messages` in a SQLite database with the same schema the desktop app uses.

Add `--session <id>` to continue an existing session. The `providerSessionId` is persisted at the end of every turn and handed back to the SDK on the next one, so a second process resumes the same conversation rather than starting a fresh one.

## `serve`: a headless device on the user's personal sync

```sh
nimbalyst-node serve --config ./nimbalyst-node.config.json
```

Long-running. Joins the user's personal index room as a device of type `headless`, claims create-session requests addressed to its `deviceId`, checks out the mapped repository branch, runs Claude Code turns, streams the transcript back through the session room, and drains queued prompts. `SIGTERM` exits 0; a revoked credential exits 3; a missing argument exits 2.

The one-turn CLI above is untouched and needs none of this configuration.

### What it does not do

Only the desktop performs the device-authorization handshake (`/auth/device/code`, `/approve`, `/token`). This process only ever **refreshes** an already-issued credential. It also never reads a credential, key or endpoint from the environment — see [Configuration](#configuration).

Anthropic authentication is likewise not this package's business: the container launcher clears the environment and sets `HOME`, and the `claude` CLI finds `~/.claude/.credentials.json` there.

### Configuration for `serve`

Two extra keys, on top of `databasePath` and `trust.mode`. See `nimbalyst-node.serve.config.example.json`.

| Key | Meaning |
| --- | --- |
| `sync.serverUrl` | Collab server origin, e.g. `https://sync.nimbalyst.com`. |
| `sync.credentialPath` | `node-credential.json`. Rewritten atomically on every refresh. |
| `sync.encryptionKeySeed` | Base64 seed the personal-sync AES key is derived from. |
| `sync.personalOrgId` / `sync.personalUserId` | The user's **personal** org and member id. A team member id here derives a different key and silently makes every synced row undecryptable. |
| `sync.deviceId` | Stable id this node announces under; create-session requests target it. Configured, not derived — a container's hostname changes every deployment, and a device id that moves is one the desktop can never address twice. |
| `sync.deviceName` | Shown in the desktop's device list. |
| `workspacesPath` | The project → checkout map below. |
| `checkoutRoot` | Optional. Absolute directory every `checkoutDir` must live under; defaults to `/workspace`. A confinement boundary, not a convenience — the update path resets a git tree, so a mapping pointing at `/` would reset it there. Set it explicitly when developing outside a container. |

### The workspaces file

A create-session request carries the **requester's** workspace path as `projectId` — an absolute path on their Mac, which does not exist here. This file maps it to something this node can check out. See `workspaces.example.json`.

```json
{
  "workspaces": [
    {
      "projectId": "/Users/someone/sources/stravu-editor",
      "repoUrl": "https://github.com/nimbalyst/nimbalyst.git",
      "branch": "main",
      "checkoutDir": "/workspace/stravu-editor"
    }
  ]
}
```

It is re-read on **every** request, so the desktop can map a new project without restarting the node. An unmapped `projectId` is answered with `success: false` and the reason, not ignored.

`branch`, `repoUrl` and `checkoutDir` are validated before any of them reaches git's argv. Passing an argv array stops the *shell*, not git's own option parsing — a branch named `--upload-pack=/bin/sh` is read as an option and executes either way — so branch names are allowlisted, remotes must be `https://` with a hostname, and `checkoutDir` must resolve (through symlinks) to somewhere under `checkoutRoot`.

`checkoutDir` is the agent's working directory and nothing else. The session published to the index carries the requester's `projectId`, so the desktop groups it under the project the user actually has open. git runs once, when the session is created (`clone --depth 1`, or `fetch` + `checkout -B <branch> FETCH_HEAD`); a queued follow-up turn reuses the tree as the previous turn left it, because resetting to the branch head between turns would discard work the agent has not committed.

### Five things that are load-bearing and not obvious

**The refresh token rotates on every use, and presenting a superseded one destroys the credential.** The dangerous window is not the write, it is the gap between the server rotating and the node learning it did — a crash there leaves the old token on disk and the next start replays it into a permanent revocation. So a rotation is a three-phase durable transaction: fsync a `refreshInFlightAt` marker *before* presenting the token, fsync the replacement on the response, and only then hand the access token out. A token that is not on disk is never used.

A marker found on disk at startup is **terminal, and nothing is sent**: phase 2 writes the replacement without the marker, so a marker that survived proves the replacement was never stored, and this process cannot know whether the server rotated. Replaying there is the one move that can destroy a credential which is still alive, so the node exits 3 and the desktop re-provisions. A crash that happened to beat the server pays the same price — a re-provision is a defined recovery, a destroyed credential is not.

A refresh has three outcomes, and the line between them is **whether the request was sent** — not what the status code says:

| Outcome | Trigger | What happens |
| --- | --- | --- |
| transient | the request provably never left this machine: `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`, `EADDRNOTAVAIL`, `UND_ERR_CONNECT_TIMEOUT` | retry with backoff (5s, doubling to a 60s cap), and **clear** the marker — nothing was transmitted, so the token is untouched. Never exit 3. |
| uncertain | anything else once the request has gone out: 5xx, a lost response, a malformed 2xx, a 400 without a revocation code, or a replacement that could not be persisted | terminal, exit 3, marker kept. The token is never presented again. |
| revoked | HTTP 400 with `invalid_grant` or `expired_token`, and nothing else | terminal, exit 3. Latched, so the rejected token is never presented twice. |

**A 5xx does not mean the server did nothing.** It mints the access token *after* committing the rotation, so a mint failure returns 503 on a credential it has already spent — and retrying there is exactly the replay that destroys it. The asymmetry is deliberate: a needless re-provision costs one dialog, a replayed refresh token costs the credential. Backoff still matters for the one case that does retry: the access token expires at minute fifteen and rotation runs at twelve, so "retry on the next tick" would leave the node up, healthy and answering nothing until minute twenty-four.

**One submission path for the initial prompt, and de-duplication by identity only.** The prompt that arrives inside a create-session request is run directly and recorded in the queue as already completed under the id `request:<requestId>`. The desktop does not also queue it; if an older client does, that row collides with the recorded id and is skipped — forever, not for sixty seconds. Nothing compares prompt text or timestamps: text is not identity, so a text-and-clock rule both misses a copy that arrives late and silently swallows a user who deliberately sends the same words twice.

**A restart must not replay a turn.** Prompts the previous process left `pending` never started, so they are driven at startup. A prompt left `executing` is a different thing: its turn wrote files and ran commands, so re-running it is a second uncoordinated attempt rather than a retry. Those are failed, with a note in the session's own transcript saying so.

**A claim belongs to a socket, not to the node.** The server accepts a create-session response only on the socket that received the broadcast; answering on a later one is rejected and the requester is told the host vanished. Each request therefore carries `receiptGeneration` — `getConnectionGeneration()` as it was when the broadcast *arrived*, stamped by the provider **before** it decrypts, because decryption is asynchronous and the socket can die inside it. Reading the generation on delivery instead would read the new socket's and conclude the claim was still ours. It is re-checked on delivery, after the checkout, after the session is created, and before the prompt runs; abandoning before anything exists also un-marks the requestId, so the requester's retry is not suppressed as a duplicate. None of this is inferred from `isIndexReady()`, which cannot see a disconnect and reconnect that both complete between two reads — precisely the shape the twelve-minute rotation has.

**Announced is not the same as eligible.** The server routes work only to a socket that is both `synced` and announced as an execution host. `deviceAnnounce` is automatic (on open, then every 30s); `synced` is not — it is set when the server answers an index read, which `CollabV3Sync` issues from `fetchIndex()` and nowhere on connect. A node that only connects looks entirely healthy — open socket, device in the presence list, no errors — and is silently skipped by every host selection. `serve` therefore reads the index on connect, after each reconnect, and on a slow heartbeat. See `src/serve/indexEligibility.ts`.

### Not implemented yet

- **Interactive prompt answers.** `prompt_response` / `question_response` control messages are logged and dropped. Under `trust.mode: bypass-all` tool permissions never prompt, but an `AskUserQuestion` from an MCP server will sit unanswered until the turn's own timeout.
- **Worktree requests.** `onCreateWorktreeRequest` is not subscribed; the desktop is still the only worktree host.
- **Durable replay of unpublished transcript rows.** A publication covers the whole send (`onMessageCreated` awaits the provider's `pushChange`, so encryption and transport are included) and reports what happened rather than throwing — a failed connect or a withheld write comes back as `{ published: false }`, which is *not* success, and treating it as such meant a node that had never connected reported zero failures while sending nothing. Shutdown waits up to 10s for in-flight publications and 15s for everything, and a row that did not publish is held and retried on **every** reconnect via `onConnectionGenerationChange`, not just the twelve-minute rotation. But that buffer is memory only and capped at 500 rows: a row still unsent when the process exits stays correct in the local database and invisible to every other device. Durable replay needs a published-watermark per session and is deferred.

## Configuration

`--config` is required and has no default. Provider API keys and MCP servers must be explicitly provisioned in that file. The agent child receives only OS/runtime environment locations plus Nimbalyst's managed options; ambient provider keys and endpoint overrides are excluded. CLI OAuth login can still use the current user's credential store.

```json
{
  "databasePath": "./data/nimbalyst.sqlite",
  "trust": { "mode": "bypass-all" }
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `databasePath` | yes | SQLite file. Relative paths resolve against the config file's directory. |
| `schemaDir` | no | Migration directory. Defaults to the in-repo copy under `packages/electron`. |
| `claudeCodePath` | no | Explicit `claude` executable. Otherwise the SDK's bundled native binary is resolved. |
| `providerApiKeys` | no | Explicitly-provisioned credentials by provider id. Claude Code needs none. |
| `trust.mode` | yes | Explicit `bypass-all`. Missing, invalid, `ask`, and `allow-all` policies are rejected before opening the database; the latter two need a permission responder. |
| `mcpServers` | no | Explicit MCP server map; defaults to no external servers. Provision literal values: unexpanded `${...}` references are rejected with the server and field name, never expanded against the host environment. |

`trust.mode` grants the agent the operating-system user's permissions. `--workspace` sets the working directory; it does not confine file access. Use a disposable isolated environment for untrusted repositories, and keep unrelated workspaces and privileged credentials outside it.

Headless runs disable implicit MCP discovery and user/project/local settings sources, including executable repository hooks and automatic `CLAUDE.md` project-instruction loading. The SDK also receives `skills: []`, `agents: {}`, and `plugins: []`; Nimbalyst's extension plugin loader is skipped. Only the `mcpServers` map you provision is supplied to the SDK. Desktop configuration discovery is unaffected.

## Schema

The DDL is **not** restated in this package. `db/migrations.ts` reads the same numbered `.sql` files `packages/electron`'s `MigrationRunner` reads, applies them through an identical `_migrations` ledger, and `src/__tests__/migrations.test.ts` asserts the derived list matches `getMigrations()` exactly — so the day someone adds a non-file migration this fails here rather than producing a database that is silently a version behind.

Those files currently live only inside the Electron app package, which means an installed copy of this package must be handed a `schemaDir`. Extracting the schema into a package both hosts depend on is the fix, and it is not in scope for phase 0.

## Not in scope

Team collaboration. `serve` speaks **personal** sync only — the personal index room and session rooms, authorized by this node's own personal-scoped access token. Tracker rooms, shared documents and the team room all require a team JWT this process never holds.
