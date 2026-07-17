import { describe, expect, it } from 'vitest';
import {
  getPhasePresentation,
  isValidSessionPhase,
  SESSION_PHASE_COLUMNS,
  SESSION_PHASES,
} from '../phase';

const expected = [
  ['backlog', 'Backlog', '#6b7280'],
  ['planning', 'Planning', '#60a5fa'],
  ['implementing', 'Implementing', '#eab308'],
  ['validating', 'Validating', '#a78bfa'],
  ['complete', 'Complete', '#4ade80'],
] as const;

describe('session phase presentation', () => {
  it('publishes all five phases once in display order', () => {
    expect(SESSION_PHASES).toEqual(expected.map(([phase]) => phase));
    expect(SESSION_PHASE_COLUMNS).toHaveLength(5);
  });

  it.each(expected)('resolves %s through the canonical map', (phase, label, color) => {
    expect(isValidSessionPhase(phase)).toBe(true);
    expect(getPhasePresentation(phase)).toEqual({
      label,
      color,
      cssVar: `--nim-session-phase-${phase}`,
    });
  });

  it.each([null, undefined, '', 'unknown', 'constructor', 'toString', '__proto__'])(
    'does not coerce %s to backlog',
    (phase) => {
      expect(getPhasePresentation(phase)).toBeNull();
      if (typeof phase === 'string') expect(isValidSessionPhase(phase)).toBe(false);
    },
  );
});
