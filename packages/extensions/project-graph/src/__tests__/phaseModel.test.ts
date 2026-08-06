import { describe, it, expect } from 'vitest';
import { buildPhaseSegments, phaseForStatus, PHASE_DEFS } from '../timeline/phaseModel';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe('phaseForStatus', () => {
  it('maps plan statuses onto canonical phases', () => {
    expect(phaseForStatus('draft').key).toBe('draft');
    expect(phaseForStatus('ready-for-development').key).toBe('draft');
    expect(phaseForStatus('in-development').key).toBe('dev');
    expect(phaseForStatus('in-review').key).toBe('review');
    expect(phaseForStatus('completed').key).toBe('done');
    expect(phaseForStatus('blocked').key).toBe('blocked');
    expect(phaseForStatus('rejected').key).toBe('rejected');
  });

  it('maps session workflow phases onto canonical phases', () => {
    expect(phaseForStatus('backlog').key).toBe('draft');
    expect(phaseForStatus('planning').key).toBe('planning');
    expect(phaseForStatus('implementing').key).toBe('dev');
    expect(phaseForStatus('validating').key).toBe('review');
    expect(phaseForStatus('complete').key).toBe('done');
  });

  it('maps tracker statuses onto the same phases', () => {
    expect(phaseForStatus('to-do').key).toBe('draft');
    expect(phaseForStatus('in-progress').key).toBe('dev');
    expect(phaseForStatus('done').key).toBe('done');
    expect(phaseForStatus('merged').key).toBe('done');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(phaseForStatus('  In Progress ').key).toBe('dev');
  });

  it('falls back to "other" for unknown statuses, keeping the raw label', () => {
    const p = phaseForStatus('frobnicating');
    expect(p.key).toBe('other');
  });

  it('every phase def has a color var', () => {
    for (const def of PHASE_DEFS) {
      expect(def.colorVar).toMatch(/^--pg-phase-/);
    }
  });
});

describe('buildPhaseSegments', () => {
  it('returns a single open-ended segment when there is no activity history', () => {
    const segs = buildPhaseSegments({
      createdAt: NOW - 10 * DAY,
      status: 'in-development',
      now: NOW,
    });
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      phaseKey: 'dev',
      startMs: NOW - 10 * DAY,
      endMs: NOW,
    });
  });

  it('ends the single segment at closedAt when the item is closed', () => {
    const segs = buildPhaseSegments({
      createdAt: NOW - 10 * DAY,
      closedAt: NOW - 2 * DAY,
      status: 'done',
      now: NOW,
    });
    expect(segs).toHaveLength(1);
    expect(segs[0]!.endMs).toBe(NOW - 2 * DAY);
    expect(segs[0]!.phaseKey).toBe('done');
  });

  it('builds one segment per status interval from the activity log', () => {
    const segs = buildPhaseSegments({
      createdAt: NOW - 30 * DAY,
      status: 'in-review',
      now: NOW,
      activity: [
        { action: 'status_changed', oldValue: 'draft', newValue: 'in-development', timestamp: NOW - 20 * DAY },
        { action: 'status_changed', oldValue: 'in-development', newValue: 'in-review', timestamp: NOW - 5 * DAY },
      ],
    });
    expect(segs.map(s => s.phaseKey)).toEqual(['draft', 'dev', 'review']);
    // first segment spans creation -> first transition
    expect(segs[0]).toMatchObject({ startMs: NOW - 30 * DAY, endMs: NOW - 20 * DAY });
    // middle segment spans the two transitions
    expect(segs[1]).toMatchObject({ startMs: NOW - 20 * DAY, endMs: NOW - 5 * DAY });
    // last segment runs to now (still open)
    expect(segs[2]).toMatchObject({ startMs: NOW - 5 * DAY, endMs: NOW });
  });

  it('uses the earliest activity oldValue as the creation-time status', () => {
    const segs = buildPhaseSegments({
      createdAt: NOW - 30 * DAY,
      status: 'done',
      now: NOW,
      activity: [
        { action: 'status_changed', oldValue: 'to-do', newValue: 'done', timestamp: NOW - 1 * DAY },
      ],
    });
    expect(segs.map(s => s.phaseKey)).toEqual(['draft', 'done']);
  });

  it('sorts out-of-order activity and ignores non-status entries', () => {
    const segs = buildPhaseSegments({
      createdAt: NOW - 30 * DAY,
      status: 'in-review',
      now: NOW,
      activity: [
        { action: 'commented', timestamp: NOW - 6 * DAY },
        { action: 'status_changed', oldValue: 'in-development', newValue: 'in-review', timestamp: NOW - 5 * DAY },
        { action: 'status_changed', oldValue: 'draft', newValue: 'in-development', timestamp: NOW - 20 * DAY },
      ],
    });
    expect(segs.map(s => s.phaseKey)).toEqual(['draft', 'dev', 'review']);
  });

  it('merges adjacent segments that resolve to the same phase', () => {
    const segs = buildPhaseSegments({
      createdAt: NOW - 30 * DAY,
      status: 'in-progress',
      now: NOW,
      activity: [
        // to-do and backlog both map to the draft phase -> should collapse
        { action: 'status_changed', oldValue: 'to-do', newValue: 'backlog', timestamp: NOW - 20 * DAY },
        { action: 'status_changed', oldValue: 'backlog', newValue: 'in-progress', timestamp: NOW - 10 * DAY },
      ],
    });
    expect(segs.map(s => s.phaseKey)).toEqual(['draft', 'dev']);
    expect(segs[0]).toMatchObject({ startMs: NOW - 30 * DAY, endMs: NOW - 10 * DAY });
  });

  it('drops zero-length segments from same-timestamp transitions', () => {
    const segs = buildPhaseSegments({
      createdAt: NOW - 30 * DAY,
      status: 'in-review',
      now: NOW,
      activity: [
        { action: 'status_changed', oldValue: 'draft', newValue: 'in-development', timestamp: NOW - 10 * DAY },
        { action: 'status_changed', oldValue: 'in-development', newValue: 'in-review', timestamp: NOW - 10 * DAY },
      ],
    });
    // dev interval has zero width and is dropped
    expect(segs.map(s => s.phaseKey)).toEqual(['draft', 'review']);
  });

  it('returns an empty array when there is no date information at all', () => {
    expect(buildPhaseSegments({ status: 'draft', now: NOW })).toEqual([]);
  });

  it('clamps activity timestamps that precede createdAt', () => {
    const segs = buildPhaseSegments({
      createdAt: NOW - 10 * DAY,
      status: 'in-development',
      now: NOW,
      activity: [
        { action: 'status_changed', oldValue: 'draft', newValue: 'in-development', timestamp: NOW - 20 * DAY },
      ],
    });
    // the pre-creation transition is clamped, leaving a single dev segment
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ phaseKey: 'dev', startMs: NOW - 10 * DAY, endMs: NOW });
  });
});
