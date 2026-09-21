// @vitest-environment node
import { expect, it } from 'vitest';
import { hasShellCoverageGap, isShellCoverageFault, shellCoverageDetails } from '../shellTrackingCoverage';

it('keeps competing owners informational while same-session tool overlap remains a fault', () => {
  expect(isShellCoverageFault('competingOwners')).toBe(false);
  expect(hasShellCoverageGap({ competingOwners: 3067 })).toBe(false);
  expect(shellCoverageDetails([{ sessionId: 'A', state: 'no-detected-fault', reasons: { competingOwners: 1 }, turns: [] }])).toEqual([]);
  expect(isShellCoverageFault('toolOverlap')).toBe(true);
  expect(hasShellCoverageGap({ competingOwners: 1, toolOverlap: 1 })).toBe(true);
});
