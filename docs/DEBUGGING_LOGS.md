# Debugging with Log Access Tools

Agents have access to comprehensive logging tools. **Never ask users to copy-paste logs** — use these tools instead:

1. **`get_main_process_logs`** — Main process log file (file system, IPC, AI providers).
2. **`get_renderer_debug_logs`** — Renderer debug log file (UI errors, React components, console output).

## Workflow

1. Check recent renderer logs: `get_renderer_debug_logs(lastLines: 100, logLevel: "error")`
2. Check main process: `get_main_process_logs(component: "FILE_WATCHER", logLevel: "error")`
3. Search for specific errors: `get_renderer_debug_logs(searchTerm: "TypeError", lastLines: 200)`
4. Investigate previous session crash: `get_renderer_debug_logs(session: 1, logLevel: "error")`

## When to use each tool

- **`get_main_process_logs`**: File watcher issues, IPC errors, AI provider failures, database errors (persisted log file).
- **`get_renderer_debug_logs`**: UI errors, React component issues, console output, crash investigation (dev mode only, persists across restarts).

## Log volume and routing

Main-process logs default to `info` in both development and packaged builds. Existing saved logger settings still take precedence. Routine watcher startup, polling reads, fleet snapshots, and MCP tool-call breadcrumbs use `debug`; warnings, errors, slow-operation diagnostics, and watcher recovery remain visible. MCP request metadata is not dumped into logs.

For a targeted main-process trace, use `updateLoggerConfig({ globalLevel: LogLevel.DEBUG })` and `updateComponentConfig(component, true, LogLevel.DEBUG)` from the main-process logger module, then restore the previous settings. Both the transport and component thresholds must allow the message.

Main messages go once to each enabled main-process sink (file and terminal). They are not broadcast into every renderer console. Use `get_main_process_logs` for those messages; the renderer debug log captures renderer-originated console output. Disabling the outgoing broadcast does not disable renderer-to-main log forwarding.

Codex's repeated connection-failure stderr for an unavailable localhost MCP integration is summarized once per endpoint per agent process at `info`. The original stderr remains in its diagnostic tail. Remote connection failures, authentication errors, and tool failures retain their existing error reporting.
