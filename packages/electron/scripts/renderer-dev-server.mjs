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

const server = await createServer(config.renderer);
await server.listen();
server.printUrls();
process.send?.({ type: 'ready' });

// Leave a small memory breadcrumb in the dev terminal for multi-day failures.
const memoryLog = setInterval(() => {
  const { rss, heapUsed } = process.memoryUsage();
  console.log(`[renderer-dev-server] pid=${process.pid} uptime=${Math.round(process.uptime())}s rss=${Math.round(rss / 1048576)}MiB heap=${Math.round(heapUsed / 1048576)}MiB`);
}, 15 * 60_000);
memoryLog.unref();

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Do not orphan Vite if its supervisor dies unexpectedly.
process.on('disconnect', shutdown);
