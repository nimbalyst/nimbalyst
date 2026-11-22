# Running your project's dev servers from Nimbalyst (Run Manager, alpha)

Run Manager keeps the long-running processes of a project (a dev server, an API, a worker, a watcher) in one place: you see whether each is up, start, stop or restart it with one click, and open its log. Agents get the same controls, so "restart the server and tell me if it came back" works without copying output around.

Run Manager is a built-in extension that appears only when developer mode is on (Settings > Advanced). You can turn it off in Settings > Extensions.

## Open the Runs panel

Click the Runs button (a play icon in a circle) in the left gutter. The button carries a colored dot:

- red: a target crashed
- amber: a target is starting or stopping
- green: at least one target is running and none is starting or crashed
- no dot: nothing is running

## Add a run target

Click **Add run target** and fill in:

- **Name**: what the row and the terminal tab are called.
- **Command**: the command line, for example `pnpm run dev`. It runs through your login shell, so your PATH and version managers apply.
- **Port** (optional): the port the process listens on. Nimbalyst uses it to tell when the target is ready, to link to `http://localhost:<port>`, and to notice a copy you started somewhere else.
- **Folder** (optional): a folder inside the project to run the command in.

If the project has no targets yet and its `package.json` has a `dev`, `start`, `serve` or `watch` script, those are offered as one-click starting points. Nothing is written until you click **Add**.

## The run targets file

Targets are saved in `.nimbalyst/run.json` in the project. Commit it so the team shares the same targets. Click the file name at the right of the Runs panel to edit it directly.

```json
{
  "targets": [
    { "id": "web", "name": "Web dev server", "command": "pnpm run dev", "port": 5173 },
    { "id": "api", "name": "API", "command": "npx wrangler dev", "cwd": "packages/api", "readyPattern": "Ready on" },
    { "id": "worker", "name": "Queue worker", "command": "pnpm run worker", "env": { "LOG_LEVEL": "debug" } }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Stable id: lowercase letters, digits, `-` and `_`. Agents refer to the target by it. |
| `name` | Display name. |
| `command` | Command line to run. |
| `cwd` | Folder inside the project to run in. Default: the project root. |
| `port` | Port the process listens on. |
| `url` | Link to show instead of `http://localhost:<port>`. |
| `env` | Extra environment variables. The file is committed, so do not put secrets here. |
| `readyPattern` | Regular expression matched against the output to decide the target is ready, for a target without a port. |

Nimbalyst reloads the file when it changes. A target with a mistake is skipped and the problem is shown at the top of the panel; the other targets still load.

## Start, stop, restart, logs

- **Start** runs the command in a new pinned terminal tab. That tab is the log: you can read it, scroll it and type into it. Each start begins with an empty log.
- A target is **starting** until its port accepts connections, or its `readyPattern` appears in the output, or, with neither, as soon as the process is spawned. Then it is **running**.
- **Stop** sends SIGTERM to the command's process group, which covers the processes it started unless one of them moved itself into a different group or session. Anything in the group still alive after 5 seconds is sent SIGKILL. On Windows the process tree is ended with `taskkill` instead, and only the command itself is checked afterwards. Closing the target's terminal tab stops it the same way.
- **Restart** stops the target and starts it again.
- **Logs** opens the target's terminal tab. The **Runs** tab at the left of the terminal panel leads back.
- A target that exits before it is ready, or exits with a non-zero code, is **crashed**; the exit code is shown.

Nothing starts by itself. Nimbalyst stops every run when you quit, restart or update it, close the project, or turn the extension or developer mode off. At quit a run gets 2 seconds to exit before SIGKILL. If Nimbalyst crashes or is force-quit, runs are not stopped; a target with a port shows as **external** the next time.

## A process you started somewhere else

If a target is not running in Nimbalyst but something is already listening on its port, the row shows **external** with that process's id. Nimbalyst will not start a second copy. You can stop the external process from the row; Nimbalyst asks first, since it did not start it. There is no log for it.

## Agent tools

| Tool | What it does |
| --- | --- |
| `run_list` | Lists the targets with status, pid, port, URL and uptime. |
| `run_start`, `run_restart` | Start or restart a target and wait until it is ready (30 seconds by default, 120 at most). If it fails, the reply includes the last 40 lines of the log. |
| `run_stop` | Stops a target. |
| `run_logs` | Returns the log as plain text: the last N lines, or only what is new since an earlier call. |
| `run_configure` | Adds, edits or removes a target. |

Starting, stopping and reading a target that is already in `.nimbalyst/run.json` does not ask for permission. `run_configure` does, because it defines a command that will run.

## Limits in this alpha

- No automatic restart after a crash.
- No ordering between targets ("start the API before the web app").
- No one-shot tasks; a run target is a process that keeps running.
- The log holds what the terminal tab holds; very old output scrolls away.
