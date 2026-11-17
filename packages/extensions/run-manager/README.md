# Run Manager (alpha)

Built-in, developer-mode extension for a project's long-running processes: dev servers, workers, watchers. User documentation is in [support/run-manager.md](../../../support/run-manager.md).

- Extension id: `com.nimbalyst.run`. The last segment names the agent tools: `run_list`, `run_start`, `run_stop`, `run_restart`, `run_logs`, `run_configure` (served as `mcp__nimbalyst-run__run_*`).
- `requiresDeveloperMode: true`: the panel, its gutter button and the tools exist only while developer mode is on.
- Run targets come from the project's committed `.nimbalyst/run.json`.

## Layout

| Path | Role |
| --- | --- |
| `src/backend.ts` | Backend module entry: reads and watches the config, publishes the gutter badge, registers the tools. |
| `src/backend/runManager.ts` | State per target, start, readiness, stop, external-process detection. No I/O of its own; everything comes in as dependencies. |
| `src/backend/runConfig.ts` | Parser and editor for `.nimbalyst/run.json`. |
| `src/backend/runStatus.ts` | Status state machine and what counts as a clean exit. |
| `src/backend/probes.ts` | Port probe, listener lookup (`lsof`, `netstat`), stopping an external process. |
| `src/backend/suggestions.ts` | Targets suggested from `package.json` scripts. |
| `src/backend/runTools.ts` | Agent tools and the panel-only tools. |
| `src/components/RunsPanel.tsx` | The Runs panel. Talks to the backend only through `host.callBackendTool`. |
| `src/components/runsModel.ts` | What a row shows and which actions a status allows. |
| `src/shared/types.ts` | Types and tool names shared by both sides. |

## How a run works

Each start calls `ctx.services.terminals.createCommandTerminal` with the target id as the key, so the host replaces the target's previous tab and the log starts empty. The terminal tab is the log; `run_logs` reads it through the handle's `read()`. Stopping goes through the handle's `stop()`: SIGTERM to the process group, SIGKILL after 5 seconds, then a check that the group is gone. The host stops every terminal the module owns when the module stops and when the app quits.

Readiness is a TCP probe on `port`, else `readyPattern` matched against the output with ANSI sequences removed, else "running once spawned".

## Related host code

- `packages/electron/src/main/extensions/backendTerminals.ts`: host side of `ctx.services.terminals`.
- `packages/runtime/src/ai/server/providers/claudeCode/toolPolicy.ts`: the five non-configuring tools are auto-allowed; `run_configure` is not.
- `packages/runtime/src/ui/AgentTranscript/components/CustomToolWidgets/RunToolWidget.tsx`: transcript line for start, stop and restart.

## Develop

Tests run from the repository root: `pnpm exec vitest run packages/extensions/run-manager`. Apply changes to a running app with `extension_reload`; the backend module needs the extension toggled off and on.
