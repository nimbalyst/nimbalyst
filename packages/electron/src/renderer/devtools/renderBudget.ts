/**
 * Render-budget test harness.
 *
 * Lets a test assert how many times a component re-rendered while some action
 * ran, without mocking a leaf component to count it indirectly.
 *
 *   // FIRST import in the file — before @testing-library/react, so the
 *   // DevTools hook shim exists before react-dom initializes.
 *   import { measureRenders } from '../../devtools/renderBudget';
 *   import { render, act } from '@testing-library/react';
 *
 *   const budget = await measureRenders(async () => {
 *     await act(async () => { streamFiftyDeltas(store); });
 *   });
 *   expect(budget.rendersOf('SessionListRow')).toBe(1);
 *
 * `budget.report()` prints the ranked table with the "why" column, which is what
 * you want in the failure message when a budget regresses.
 */

import { renderProfiler, type RenderProfilerSnapshot } from './renderProfiler';

export interface RenderBudget {
  snapshot: RenderProfilerSnapshot;
  rendersOf(componentName: string): number;
  /** Total renders across every component — a blunt whole-tree budget. */
  totalRenders: number;
  commits: number;
  /** Human-readable ranked table; attach it to a failing assertion. */
  report(limit?: number): string;
}

function buildReport(snapshot: RenderProfilerSnapshot, limit: number): string {
  if (!snapshot.components.length) return '(no renders recorded)';
  const lines = snapshot.components.slice(0, limit).map(c => {
    const why = Object.entries(c.reasons)
      .map(([reason, count]) => `${reason} x${count}`)
      .join('; ');
    return `  ${c.renders.toString().padStart(5)}  ${c.name}${why ? `  — ${why}` : ''}`;
  });
  return [`${snapshot.totalRenders} renders across ${snapshot.commits} commits:`, ...lines].join('\n');
}

/**
 * Reads the budget's own snapshot rather than the profiler's live counters, so
 * a budget stays valid after the next `measureRenders`.
 *
 * Tolerates a trailing bundler suffix: esbuild renames the inner function of
 * `const Foo = memo(function Foo() {…})` to `Foo2` to avoid shadowing the
 * const, so the profiler sees `Foo2` while every caller reasonably asks for
 * `Foo`.
 */
function lookup(snapshot: RenderProfilerSnapshot, name: string): number {
  const exact = snapshot.components.find(c => c.name === name);
  if (exact) return exact.renders;
  const suffixed = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+$`);
  return snapshot.components.filter(c => suffixed.test(c.name)).reduce((sum, c) => sum + c.renders, 0);
}

function toBudget(snapshot: RenderProfilerSnapshot): RenderBudget {
  return {
    snapshot,
    rendersOf: (name: string) => lookup(snapshot, name),
    totalRenders: snapshot.totalRenders,
    commits: snapshot.commits,
    report: (limit = 20) => buildReport(snapshot, limit),
  };
}

/**
 * Record renders that happen while `action` runs.
 *
 * Mount the tree *before* calling this when you want to measure an update in
 * isolation — otherwise the mount's renders are in the budget too.
 */
export async function measureRenders(action: () => void | Promise<void>): Promise<RenderBudget> {
  renderProfiler.start();
  try {
    await action();
  } finally {
    // Stop even if the action threw, so one failing test can't leave the
    // profiler recording into the next one. `stop()` in a finally must not
    // return — that would swallow the action's error.
    renderProfiler.stop();
  }
  return toBudget(renderProfiler.snapshot());
}

/** Manual form for tests that need to interleave assertions with recording. */
export function startBudget(): { finish(): RenderBudget } {
  renderProfiler.start();
  return { finish: () => toBudget(renderProfiler.stop()) };
}
