/**
 * Wires the render + atom-write profilers onto `window.__renderProfiler`.
 *
 * Import this FIRST in every renderer entry point — before `react` and
 * `react-dom` — because the DevTools hook shim it pulls in must exist before
 * react-dom initializes. See `renderProfiler.ts`.
 *
 * Nothing records until someone calls `start()`, from the Developer Dashboard's
 * Renders tab or from an agent:
 *
 *   await window.__renderProfiler.start()
 *   // ... exercise the app ...
 *   await window.__renderProfiler.stop()
 */

import { renderProfiler, type RenderProfilerSnapshot } from './renderProfiler';
import type { AtomWriteStat } from './atomWriteProfiler';

export interface CombinedSnapshot extends RenderProfilerSnapshot {
  atoms: AtomWriteStat[];
  atomWrites: number;
  atomsPerSec: number;
  atomTrackingUnavailable: string | null;
}

// Loaded lazily so the entry point's first import stays cheap and does not drag
// the Jotai store into module init ahead of the app's own ordering.
type AtomProfiler = typeof import('./atomWriteProfiler').atomWriteProfiler;
let atomProfiler: AtomProfiler | null = null;

async function loadAtomProfiler(): Promise<AtomProfiler | null> {
  if (atomProfiler) return atomProfiler;
  try {
    atomProfiler = (await import('./atomWriteProfiler')).atomWriteProfiler;
    return atomProfiler;
  } catch {
    return null;
  }
}

function combine(base: RenderProfilerSnapshot): CombinedSnapshot {
  const atomSnapshot = atomProfiler?.snapshot();
  const perSec = base.durationMs > 0 ? ((atomSnapshot?.totalWrites ?? 0) * 1000) / base.durationMs : 0;
  return {
    ...base,
    atoms: atomSnapshot?.atoms ?? [],
    atomWrites: atomSnapshot?.totalWrites ?? 0,
    atomsPerSec: Number(perSec.toFixed(2)),
    atomTrackingUnavailable: atomSnapshot?.unavailableReason ?? null,
  };
}

export async function start(): Promise<{ started: true }> {
  renderProfiler.start();
  await (await loadAtomProfiler())?.start();
  return { started: true };
}

export async function stop(): Promise<CombinedSnapshot> {
  const base = renderProfiler.stop();
  const combined = combine(base);
  atomProfiler?.stop();
  return combined;
}

export function snapshot(): CombinedSnapshot {
  return combine(renderProfiler.snapshot());
}

export async function reset(): Promise<void> {
  renderProfiler.reset();
  await atomProfiler?.start(true);
}

export const combinedRenderProfiler = {
  start,
  stop,
  snapshot,
  reset,
  isRecording: () => renderProfiler.isRecording(),
  rendersOf: (name: string) => renderProfiler.rendersOf(name),
  lifetimeCommitCount: () => renderProfiler.lifetimeCommitCount(),
};

// Exposed for `executeJavaScript` from main (the `dev:render-profiler` IPC) and
// for `renderer_eval` from an agent.
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  (window as any).__renderProfiler = combinedRenderProfiler;
}
