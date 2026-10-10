#!/usr/bin/env node
/**
 * Run only the renderer Vite dev server, and keep it running.
 *
 * `electron-vite dev` exits when Electron exits, taking the renderer server and
 * its in-memory transform cache with it, so every `/restart` recompiled the
 * whole renderer graph (~2,600 modules, ~30s) before any window could paint.
 * `dev-loop.sh` starts this once and relaunches only Electron, which loads from
 * this already-warm server.
 *
 * Resolves the config exactly the way `electron-vite dev` does, then starts the
 * renderer server from it. Must run with packages/electron as the cwd.
 */
import { resolveConfig } from 'electron-vite';
import { createServer } from 'vite';

process.env.NODE_ENV_ELECTRON_VITE = 'development';

const { config } = await resolveConfig({}, 'serve', 'development');
if (!config?.renderer) {
  console.error('[renderer-dev-server] electron.vite.config.ts has no renderer config');
  process.exit(1);
}

// E2E runners pin the host: where `localhost` resolves to ::1 (Docker), a
// client probing 127.0.0.1 would never reach the server.
const host = process.env.NIMBALYST_RENDERER_HOST;
const server = await createServer(
  host ? { ...config.renderer, server: { ...config.renderer.server, host } } : config.renderer,
);
await server.listen();
server.printUrls();

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
