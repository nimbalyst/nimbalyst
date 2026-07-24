# Error Handling Philosophy

**Fail fast, fail loud. Never hide failures.**

## Rules

1. **Never log-and-continue for required parameters** — throw immediately instead.
2. **Never fall back to default values that mask routing issues** — fail if routing is broken.
3. **Always use stable identifiers for routing** — workspace paths (stable), not window IDs (transient).
4. **Validate at boundaries** — all IPC handlers and service methods MUST validate required parameters.
5. **Workspace-scoped IPC must take `workspacePath` as a required parameter** — the renderer always knows its window's workspace; pass it explicitly. Main-process handlers and services MUST NOT fall back to module-level "current workspace" state — that state is shared across windows and last-write-wins between them, producing silent cross-window pollution (e.g. `[SessionManager] Rejecting session ... belongs to /path/A, not /path/B`).

## Carve-out for app-global channels

Genuinely app-global channels (theme, app settings, app version, analytics consent, update checks) don't need a workspace. If you can't decide whether a channel is workspace-scoped, it is — default to "scoped + required parameter." See [IPC_GUIDE.md](./IPC_GUIDE.md) for the full rule and worked example.

## Workspace State Persistence

**Use deep merge for all nested workspace state updates.**

The `workspace:update-state` IPC handler uses a deep merge function (not shallow `Object.assign`). Multiple modules can safely update different fields in nested structures without overwriting each other. No manual read-modify-write needed.

## Rule of thumb

If you're adding code to "handle" missing required data, you're probably hiding a bug. Throw instead.
