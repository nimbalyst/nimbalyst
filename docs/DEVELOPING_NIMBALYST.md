# Developing Nimbalyst

There is not one single Nimbalyst development workflow. Which setup makes sense depends on what you are changing.

The two common patterns are:

- Run a dev copy of Nimbalyst and develop from inside Nimbalyst itself.
- Run one Nimbalyst build from one checkout while coding against a second checkout that is open in Nimbalyst. I often use `npm run dev:user2:loop` for that so the second instance has isolated app state.

## Basic Setup

From `packages/electron`, start Nimbalyst in dev mode with one of these:

```bash
npm run dev
npm run dev:loop
npm run dev:user2:loop
```

- `npm run dev` is fine for normal renderer work.
- `npm run dev:loop` is better when you expect to restart a lot.
- `npm run dev:user2:loop` starts a second isolated dev instance with its own `userData` and separate `out2/` build output, which avoids watcher/HMR cross-talk.

Then enable `Extension Dev Tools`:

1. Open Global Settings.
2. Go to Advanced.
3. Turn on `Extension Dev Tools`.
4. Save.

If you need alpha-only extensions or want to develop with pre-release versions, switch to the alpha release channel on the Advanced Settings panel.
The alpha channel follows published GitHub pre-releases.

## Use the Restart Loop for Main-Process Work

For renderer-only work, hot reload is usually enough. For Electron main-process, preload, startup, or MCP server changes, you'll need a main process restart.

That is where `npm run dev:loop` helps. In dev mode, `/restart` or the restart button writes a restart signal file, quits cleanly, and `scripts/dev-loop.sh` starts the app again. That gives you a reliable edit -> restart -> retest loop without having to re-run the dev command yourself each time.

Two details matter here:

- Active agent sessions are queued to continue after restart, so the same debugging session can survive app restarts.
- The user2 loop is useful when you want an isolated second copy of the app while keeping your main dev setup intact. 

## Use the Embedded Dev Tools

With `Extension Dev Tools` enabled and Nimbalyst running in dev mode, the agent can work against the live app instead of only editing files:

- `database_query` runs safe `SELECT` queries against the live PGLite database.
- `get_main_process_logs` reads the main-process log file directly.
- `get_renderer_debug_logs` reads renderer logs, including prior restart sessions.
- `renderer_eval` runs JavaScript in the renderer to inspect DOM state, styles, and runtime values.
- `capture_editor_screenshot` shows what the editor actually rendered.
- `extension_test_run` can run Playwright against the already-running Nimbalyst instance over CDP.

These tools route by workspace path, which matters when multiple projects or worktrees are open.

There is also a navigation gutter icon and menu to do quick things like rebuild an extension or restart Nimbalyst via the dev loop.


## Use E2E Tests for Complicated Main-Process Behavior

When the behavior crosses startup, sync, multiple windows, or database state, I usually switch to an end-to-end test instead of trying to prove it manually.

The main gotcha is that **PGLite has to be isolated per Electron instance**:

- Playwright runs serially in this app. Do not run Electron E2E tests in parallel.
- The default test helpers use a temp test database.
- If a test needs multiple Electron apps or custom state, give each instance its own `NIMBALYST_USER_DATA_PATH` and set `preserveTestDatabase: true`.

`packages/electron/e2e/tracker/tracker-sync-collab.spec.ts` is the reference pattern for this.

## Easy Things to Forget

- Never open the PGLite files directly from Node or a CLI while Nimbalyst is running. Use the database tools exposed through Nimbalyst instead.
- If something seems wrong about hot reload, check whether you are actually running a dev build. `get_environment_info` exists for that.
- Renderer debug logs rotate across restarts, which is useful when debugging crash/restart loops.
- In dev mode, Nimbalyst enables a CDP port, which is why Playwright can attach to the live running app.

## Related Docs

- [ALPHA_CHANNEL_SETUP.md](./ALPHA_CHANNEL_SETUP.md)
- [E2E_TESTING.md](./E2E_TESTING.md)
- [INTERNAL_MCP_SERVERS.md](./INTERNAL_MCP_SERVERS.md)
- [WORKTREES.md](./WORKTREES.md)
