import { describe, expect, it } from 'vitest';

import {
  computeSessionPhaseTransition,
  normalizeSessionPhaseMetadataUpdate,
} from '../sessionPhaseTransition';

const NOW = 1_700_000_000_000;

describe('computeSessionPhaseTransition', () => {
  it('anchors the timeline with the first phase as a status_changed entry', () => {
    const result = computeSessionPhaseTransition({ tags: ['ai'] }, 'planning', null, NOW);

    expect(result.changed).toBe(true);
    expect(result.metadata.phase).toBe('planning');
    // Existing metadata preserved.
    expect(result.metadata.tags).toEqual(['ai']);
    expect(result.metadata.activity).toHaveLength(1);
    expect(result.metadata.activity[0]).toMatchObject({
      action: 'status_changed',
      field: 'phase',
      oldValue: undefined,
      newValue: 'planning',
      timestamp: NOW,
    });
  });

  it('records a status_changed transition when the phase changes', () => {
    const existing = { phase: 'planning', activity: [] as unknown[] };
    const result = computeSessionPhaseTransition(existing, 'implementing', null, NOW);

    expect(result.changed).toBe(true);
    expect(result.metadata.phase).toBe('implementing');
    expect(result.metadata.activity).toHaveLength(1);
    expect(result.metadata.activity[0]).toMatchObject({
      action: 'status_changed',
      field: 'phase',
      oldValue: 'planning',
      newValue: 'implementing',
      timestamp: NOW,
    });
  });

  it('is a no-op when the phase did not change', () => {
    const existing = { phase: 'implementing', activity: [{ id: 'x' }] };
    const result = computeSessionPhaseTransition(existing, 'implementing', null, NOW);

    expect(result.changed).toBe(false);
    expect(result.metadata.activity).toEqual([{ id: 'x' }]);
  });

  it('is a no-op when no phase is supplied', () => {
    const existing = { phase: 'planning', tags: ['x'] };
    const result = computeSessionPhaseTransition(existing, undefined, null, NOW);

    expect(result.changed).toBe(false);
    expect(result.metadata.activity).toBeUndefined();
    expect(result.metadata.phase).toBe('planning');
  });

  it('preserves and appends to existing activity', () => {
    const existing = {
      phase: 'implementing',
      tags: ['ai'],
      activity: [
        { id: 'a0', action: 'status_changed', field: 'phase', newValue: 'planning', timestamp: 1 },
        { id: 'a1', action: 'status_changed', field: 'phase', oldValue: 'planning', newValue: 'implementing', timestamp: 2 },
      ],
    };
    const result = computeSessionPhaseTransition(existing, 'validating', null, NOW);

    expect(result.metadata.activity).toHaveLength(3);
    expect(result.metadata.activity[0].id).toBe('a0');
    expect(result.metadata.activity[2]).toMatchObject({
      oldValue: 'implementing',
      newValue: 'validating',
    });
  });

  it('attributes the transition to the provided identity', () => {
    const identity = { email: 'greg@stravu.com' };
    const result = computeSessionPhaseTransition({}, 'planning', identity, NOW);
    expect(result.metadata.activity[0].authorIdentity).toEqual(identity);
  });

  it('bounds the activity log to the last 100 entries', () => {
    const activity = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, action: 'status_changed', timestamp: i }));
    const existing = { phase: 'implementing', activity };
    const result = computeSessionPhaseTransition(existing, 'complete', null, NOW);

    expect(result.metadata.activity).toHaveLength(100);
    expect(result.metadata.activity[0].id).toBe('a1');
    expect(result.metadata.activity[99]).toMatchObject({ newValue: 'complete' });
  });

  it('tolerates a null existing metadata blob', () => {
    const result = computeSessionPhaseTransition(null, 'backlog', null, NOW);
    expect(result.changed).toBe(true);
    expect(result.metadata.phase).toBe('backlog');
    expect(result.metadata.activity).toHaveLength(1);
  });
});

describe('normalizeSessionPhaseMetadataUpdate', () => {
  it('clears awaiting-input state when a session is completed', () => {
    expect(normalizeSessionPhaseMetadataUpdate({ phase: 'complete', hasPendingPrompt: true, tags: ['ai'] }))
      .toEqual({ phase: 'complete', hasPendingPrompt: false, tags: ['ai'] });
  });

  it('preserves pending state for non-terminal workflow phases', () => {
    const metadata = { phase: 'validating', hasPendingPrompt: true };
    expect(normalizeSessionPhaseMetadataUpdate(metadata)).toBe(metadata);
  });
});
