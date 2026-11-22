#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Owns only Vite. Electron can restart independently without cooling its cache. */
export class RendererSupervisor {
  constructor({ spawnRenderer, probe, log = console.log, onReady = () => {},
    intervalMs = 15_000, startupMs = 120_000, killGraceMs = 5_000,
    stableMs = 60_000, retryMs = 1000, maxRetryMs = 30_000 }) {
    Object.assign(this, { spawnRenderer, probe, log, onReady, intervalMs, startupMs,
      killGraceMs, stableMs, retryMs, maxRetryMs });
    this.nextRetryMs = retryMs;
    this.stopped = false;
  }

  start() {
    if (this.stopped || this.run) return;
    this.onReady(false);
    const run = { failures: 0, stopping: false, healthySince: null };
    this.run = run;
    run.exited = new Promise((resolve) => { run.resolveExit = resolve; });
    const exited = (code, signal) => {
      if (this.run !== run) return;
      clearTimeout(run.timer);
      clearTimeout(run.killTimer);
      this.run = null;
      this.onReady(false);
      run.resolveExit();
      this.log(`[renderer-supervisor] Vite exited: code=${code} signal=${signal}`);
      if (!this.stopped) {
        const delay = this.nextRetryMs;
        this.nextRetryMs = Math.min(delay * 2, this.maxRetryMs);
        this.log(`[renderer-supervisor] Restarting Vite in ${delay}ms`);
        this.retryTimer = setTimeout(() => this.start(), delay);
      }
    };
    try {
      run.child = this.spawnRenderer();
    } catch (error) {
      this.log(`[renderer-supervisor] Spawn failed: ${error.message}`);
      exited(1, null);
      return;
    }
    run.child.once('exit', exited);
    run.child.on('error', (error) => {
      this.log(`[renderer-supervisor] Child error: ${error.message}`);
      // A failed spawn emits error, not exit. Kill/send errors on a live child
      // must not release ownership of its PID or launch a second server.
      if (!run.child.pid) exited(1, null);
    });
    run.child.on('message', (message) => {
      if (this.run !== run || run.stopping || run.ready) return;
      if (message?.type !== 'ready') return;
      run.ready = true;
      clearTimeout(run.timer);
      this.log(`[renderer-supervisor] Vite ready (pid=${run.child.pid})`);
      this.onReady(true);
      this.scheduleProbe(run);
    });
    run.timer = setTimeout(() => this.terminate(run, 'startup deadline exceeded'), this.startupMs);
  }

  scheduleProbe(run) {
    run.timer = setTimeout(async () => {
      let healthy = false;
      try { healthy = await this.probe(); } catch { /* A rejected probe is a health failure. */ }
      if (this.run !== run || run.stopping || this.stopped) return;
      if (healthy) {
        run.failures = 0;
        run.healthySince ??= Date.now();
        if (Date.now() - run.healthySince >= this.stableMs) this.nextRetryMs = this.retryMs;
      } else {
        run.healthySince = null;
        run.failures++;
        this.log(`[renderer-supervisor] Vite health check failed (${run.failures}/3)`);
        if (run.failures >= 3) {
          this.terminate(run, 'three consecutive health failures');
          return;
        }
      }
      this.scheduleProbe(run);
    }, this.intervalMs);
  }

  terminate(run, reason) {
    if (this.run !== run || run.stopping) return;
    run.stopping = true;
    this.onReady(false);
    clearTimeout(run.timer);
    this.log(`[renderer-supervisor] Stopping Vite (pid=${run.child.pid}): ${reason}`);
    run.child.kill('SIGTERM');
    run.killTimer = setTimeout(() => {
      if (this.run === run) run.child.kill('SIGKILL');
    }, this.killGraceMs);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const run = this.run;
    if (run) {
      this.terminate(run, 'dev loop shutdown');
      await run.exited;
    }
  }
}

export async function probeRenderer(url, timeoutMs = 10_000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const readyFile = process.argv[2];
  if (!readyFile) throw new Error('Usage: renderer-supervisor.mjs <ready-file>');
  const url = `http://localhost:${process.env.VITE_PORT || 5273}/`;
  const supervisor = new RendererSupervisor({
    spawnRenderer: () => spawn(process.execPath,
      [fileURLToPath(new URL('./renderer-dev-server.mjs', import.meta.url))],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }),
    probe: () => probeRenderer(url),
    onReady: (ready) => writeFileSync(readyFile, ready ? 'ready' : ''),
  });
  const shutdown = async () => {
    await supervisor.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  supervisor.start();
}
