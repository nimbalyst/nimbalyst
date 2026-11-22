// @vitest-environment node
import { expect, it } from 'vitest';
import { hasShellCoverageGap, isShellCoverageFault, shellCoverageDetails } from '../shellTrackingCoverage';

it('keeps competing owners informational while same-session tool overlap remains a fault', () => {
  expect(isShellCoverageFault('competingOwners')).toBe(false);
  expect(hasShellCoverageGap({ competingOwners: 3067, unreportedSession: 2 })).toBe(false);
  // Not a fault, but a withheld edit the user should know is missing from the list.
  const summary = (reasons: Record<string, number>) => [{ sessionId: 'A', state: 'no-detected-fault' as const, reasons, turns: [] }];
  expect(shellCoverageDetails(summary({ competingOwners: 1, unreportedSession: 1 }))).toEqual([
    'Edits made while another session was running a command were not linked',
    'Edits made while an agent session without tool tracking was active were not linked',
  ]);
  // Older versions recorded `uninstrumented` when they shared the link; nothing went missing.
  expect(shellCoverageDetails(summary({ uninstrumented: 4 }))).toEqual([]);
  expect(isShellCoverageFault('toolOverlap')).toBe(true);
  expect(hasShellCoverageGap({ competingOwners: 1, toolOverlap: 1 })).toBe(true);
});
