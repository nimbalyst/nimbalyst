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
