# Permissions and Backend Modules

> **Status: evolving.** The capability catalog, the manifest shape for backend
> modules, and the consent-prompt flow are all under active development and
> are expected to change before the API is considered stable. Pin to specific
> versions of `@nimbalyst/extension-sdk` and expect manifest migrations.

Extensions can run code in three places, each with a different trust model:

| Where | Trust | Used for |
| --- | --- | --- |
| Renderer (React components, slash command handlers, AI tool handlers) | Same as the editor itself; gated by host IPC brokers | UI contributions, tool handlers that only call host services |
| Backend module — `worker-thread` | Isolated from the main Electron event loop, but shares the main process | Compute-heavy indexing helpers, parsers, ML inference |
| Backend module — `utility-process` | Separate OS process via `utilityProcess.fork` | Process-spawning backends (kernels, language servers), networked daemons, anything that can crash |

## What This System Does (and Does Not) Enforce

Backend modules run native Node code. Once granted, a module can call
`require('child_process')`, `require('fs')`, `require('net')` directly.
There is no in-process sandbox that can take those capabilities away.

So the catalog deliberately does **not** include ids like `spawn-process`,
`filesystem`, or `network-internet`. Those would advertise enforcement that
doesn't actually happen. Listing them would mislead users.

What the system actually controls:

1. **Whether a backend module is allowed to run.** Any extension may declare
   one; the control is the user's first-use consent prompt, which states
   plainly that the module runs native code. Granting is workspace-trust +
   user-consent gated, and the host tears the module down on revocation.
   Built-in extensions ship inside the app bundle and are auto-granted (same
   trust domain as the app), so they skip the prompt.

2. **Whether the module may call host-brokered services.** The catalog
   permissions below all gate Nimbalyst-owned RPC -- the database, secrets,
   the workspace-file API, MCP registration. These are real per-call checks.

In other words: granting a backend module is itself the consent to run native
code on your machine. The brokered permissions are the **additional** things
the module is asking for beyond ambient Node access.

## Catalog of Host-Brokered Permissions

The host (Nimbalyst core) owns the full catalog. Extensions reference ids;
they cannot register new ones. Each id corresponds to a main-process broker
that consults the grant before serving the call.

| Id | Risk | What it allows |
| --- | --- | --- |
| `workspace-files` | low | Read and write files inside the current workspace via the host file API |
| `mcp-server-register` | elevated | Expose extension-defined MCP tools to the AI agent |
| `nimbalyst-database-read` | high | Read Nimbalyst's local PGLite store (sessions, documents, trackers) |
| `nimbalyst-database-write` | high | Modify Nimbalyst's local PGLite store |
| `secrets-read` | high | Read stored credentials, API keys, and other secrets |

Database access is split into read and write so extensions can declare
least-privilege intent without composing two grants into one.

The risk tier does not change what a permission lets your code do — it only
affects how the permission is grouped in the consent prompt.

## Declaring a Backend Module

Add a `backendModules` array to `contributions` in `manifest.json`. Each
entry declares the runtime, any additional host-brokered permissions, and
the user-facing consent copy.

```json
{
  "contributions": {
    "backendModules": [
      {
        "id": "jupyter-runtime",
        "entry": "dist/backend/jupyter.js",
        "runtime": "utility-process",
        "permissions": [
          "workspace-files"
        ],
        "enablement": {
          "default": "disabled",
          "promptOn": "firstUse",
          "purpose": "Run Jupyter kernels and execute notebook cells locally."
        }
      }
    ]
  }
}
```

A module that only needs ambient Node capabilities (spawning a child process,
opening a loopback socket, writing temp files) declares an empty
`permissions` array:

```json
{
  "id": "language-server",
  "entry": "dist/backend/lsp.js",
  "runtime": "utility-process",
  "permissions": [],
  "enablement": {
    "default": "disabled",
    "promptOn": "firstUse",
    "purpose": "Run the Pyright language server for type checking."
  }
}
```

The consent prompt still appears -- granting the module is granting "run
native code locally" -- but no brokered checkboxes are shown.

### Fields

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Unique within the extension. Lowercase, `[a-z0-9._-]`, max 64 chars |
| `entry` | `string` | Relative path to a compiled JS file. No leading `/`, no `..` segments |
| `runtime` | `"utility-process"` \| `"worker-thread"` | See the table at the top of this doc |
| `permissions` | `ExtensionPermissionId[]` | Host-brokered ids only. May be empty |
| `enablement.default` | `"disabled"` | The only supported value. Privileged code is always opt-in |
| `enablement.promptOn` | `"firstUse"` | Defer the consent prompt until the user takes an action that needs the capability |
| `enablement.purpose` | `string` | Shown verbatim in the consent prompt. Write from the user's perspective. Max 280 chars |

### Limits

- An extension may declare at most **8** backend modules. The cap keeps the
  consent prompt manageable. Consolidate if you exceed it.

### Who may ship one

Any extension may declare a backend module -- built-in, marketplace, or
dev-installed, in dev or packaged builds. There is no provenance allowlist:
installing the extension and approving its first-use consent prompt is the
trust decision. The loader still drops `contributions.backendModules` when the
declaration is **malformed** (fails shape validation) and logs a structured
warning, but that is a correctness check, not a gate on where the extension
came from.

Built-in extensions ship inside the app bundle (same trust domain as the app),
so the host auto-grants them and never raises the prompt.

### Migrating from the Old Catalog

Earlier alphas accepted `spawn-process`, `network-loopback`, `network-internet`,
and `filesystem` in a module's `permissions` array. Those ids never enforced
anything inside the backend runtime (ambient Node access defeats them), so
they've been removed from the catalog.

If your manifest still references any of them, the SDK validator emits a
non-fatal warning, the loader silently drops the unknown id when computing
effective permissions, and the module continues to load. Drop those entries
from your manifest -- the implicit "run native code" grant comes from
enabling the module, not from listing those ids.

## Renderer-Side Catalog Declarations

Panel and renderer code can also need brokered permissions (for example, the
`host.data.query()` API requires `nimbalyst-database-read`). Declare those
in a top-level `permissions.catalog` array on the manifest:

```json
{
  "permissions": {
    "filesystem": true,
    "catalog": ["nimbalyst-database-read"]
  }
}
```

`permissions.filesystem`, `permissions.ai`, and `permissions.network` are
the legacy boolean object that still governs renderer-side IPC like
`host.exec` and `host.fetch`. They will eventually be folded into the same
catalog.

## How the Consent Flow Works

1. The extension activates. Its backend modules stay **inert** —
   `enablement.default` is always `"disabled"`.
2. The user does something that needs a backend module (invokes a tool,
   opens a file the module handles, etc.).
3. The host raises a consent prompt. A banner at the top makes clear that
   enabling the module lets it run native code on the machine. Any
   additional brokered permissions are listed below, grouped by risk tier.
   The `enablement.purpose` string appears verbatim near the top.
4. If the user approves, the host spawns the chosen runtime, the module
   exposes its RPC surface, and subsequent calls go through immediately.
5. If the user revokes a grant from Settings, the host tears the module
   down. The grant set is checked again on next use.

The host does not auto-restart crashed modules. The renderer surfaces the
crash and lets the user retry.

## Build-Time Validation

`validateExtensionBundle()` calls `validateBackendModules()` against your
manifest and fails the build on:

- Unknown permission ids
- Duplicate module ids or duplicate permissions within a module
- Absolute / parent-traversal `entry` paths
- Missing or out-of-range `enablement` fields
- `enablement.purpose` longer than 280 characters
- More than `MAX_BACKEND_MODULES_PER_EXTENSION` (8) modules
- An `entry` file that does not exist on disk

Deprecated permission ids (`spawn-process` et al.) produce a non-fatal
warning rather than a build failure, so older manifests continue to load
while authors migrate.

```ts
import { validateExtensionBundle } from '@nimbalyst/extension-sdk';

const result = await validateExtensionBundle('./dist');
if (!result.valid) {
  console.error(result.errors);
  process.exit(1);
}
```

For runtime validation (host loader refusing an invalid manifest), use:

```ts
import { assertBackendModulesValid } from '@nimbalyst/extension-sdk';

assertBackendModulesValid(manifest.id, manifest.contributions?.backendModules);
```

## Types

```ts
import type {
  BackendModuleContribution,
  BackendModuleRuntime,
  BackendModuleEnablement,
  ExtensionPermissionId,
  PermissionRiskTier,
} from '@nimbalyst/extension-sdk';

type BackendModuleRuntime = 'utility-process' | 'worker-thread';
type PermissionRiskTier = 'low' | 'elevated' | 'high';

type ExtensionPermissionId =
  | 'workspace-files'
  | 'nimbalyst-database-read'
  | 'nimbalyst-database-write'
  | 'secrets-read'
  | 'mcp-server-register';

interface BackendModuleEnablement {
  default: 'disabled';
  promptOn: 'firstUse';
  purpose: string;
}

interface BackendModuleContribution {
  id: string;
  entry: string;
  runtime: BackendModuleRuntime;
  permissions: ExtensionPermissionId[];
  enablement: BackendModuleEnablement;
}
```

## Choosing a Runtime

Pick `utility-process` when any of these apply:
- The module spawns subprocesses
- The module talks to the network
- The module loads native modules that can crash
- You need OS-level isolation from the rest of the app

Pick `worker-thread` when:
- The workload is pure compute (parsing, indexing, lightweight inference)
- You need to share memory layout with the main process via
  `MessagePort` / `Transferable` objects
- The module is small enough that you trust it not to bring down the host

When in doubt, prefer `utility-process`. The added isolation costs a process
boundary on startup; in return, a crash in the module never takes down the
editor.

## What Will Change

The following are known to be in flux:

- **Catalog growth.** New brokered permission ids will be added as host
  capabilities (e.g., extension-to-extension RPC, clipboard access) reach
  the point where they need explicit consent. Existing ids will remain
  stable, but the registry version on each grant lets the host migrate
  intent if a permission is renamed or split.
- **Renderer-side capabilities.** The legacy
  `permissions: { filesystem, ai, network }` object on the manifest will
  eventually be expressed using the same id catalog so the consent prompt
  can show a single unified surface.
- **Host adapters.** A typed RPC surface that lets backend modules call into
  a curated subset of host services (filesystem, AI, configuration) is in
  progress. The shape of the adapter — what's exposed and how it's mocked
  in tests — is still being designed.

If you ship an extension that uses backend modules, treat the
`@nimbalyst/extension-sdk` version as part of your manifest. Bumping it may
require small manifest changes during this period.
