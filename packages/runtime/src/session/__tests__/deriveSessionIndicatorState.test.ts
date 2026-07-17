import { describe, expect, it } from 'vitest';
import {
  aggregateChildInputs,
  deriveSessionIndicatorState,
  type GroupIndicatorInput,
  type SessionIndicatorInputs,
  type SessionIndicatorState,
} from '../indicator';

function idleInput(): SessionIndicatorInputs {
  return {
    hasPendingInteractivePrompt: false,
    pendingPromptCount: 0,
    pendingPromptTypes: [],
    isLeadProcessing: false,
    hasChildProcessing: false,
    childProcessingCount: 0,
    queuedPromptCount: 0,
    hasUnread: false,
    hasError: false,
    errorMessage: '',
    hasWakeupAttention: false,
    hasScheduledWakeup: false,
    wakeupReason: null,
    wakeupFireAt: null,
    wakeupStatus: null,
  };
}

type IndicatorKind = SessionIndicatorState['kind'];

const precedenceCases: Array<{
  kind: IndicatorKind;
  patch: Partial<SessionIndicatorInputs>;
}> = [
  { kind: 'needs-input', patch: { pendingPromptCount: 1 } },
  { kind: 'error', patch: { hasError: true, errorMessage: 'Provider failed' } },
  { kind: 'working-self', patch: { isLeadProcessing: true } },
  {
    kind: 'working-child',
    patch: { hasChildProcessing: true, childProcessingCount: 1 },
  },
  { kind: 'queued', patch: { queuedPromptCount: 1 } },
  { kind: 'ready', patch: { hasUnread: true } },
  {
    kind: 'wakeup-attention',
    patch: {
      hasWakeupAttention: true,
      wakeupReason: 'Workspace closed',
      wakeupStatus: 'waiting_for_workspace',
    },
  },
  {
    kind: 'scheduled',
    patch: {
      hasScheduledWakeup: true,
      wakeupReason: 'Review later',
      wakeupFireAt: 9_999_999_999_999,
    },
  },
  { kind: 'idle', patch: {} },
];

describe('deriveSessionIndicatorState', () => {
  it.each(precedenceCases)('derives $kind', ({ kind, patch }) => {
    expect(deriveSessionIndicatorState({ ...idleInput(), ...patch }).kind).toBe(kind);
  });

  const pairwiseCases = precedenceCases.flatMap((higher, higherIndex) =>
    precedenceCases.slice(higherIndex + 1).map((lower) => ({ higher, lower })),
  );

  it('defines all 36 pairwise collisions for nine ordered states', () => {
    expect(pairwiseCases).toHaveLength(36);
  });

  it.each(pairwiseCases)(
    '$higher.kind wins over $lower.kind',
    ({ higher, lower }) => {
      const inputs = {
        ...idleInput(),
        ...lower.patch,
        ...higher.patch,
      };
      expect(deriveSessionIndicatorState(inputs).kind).toBe(higher.kind);
    },
  );

  it('keeps the exact unresolved prompt count', () => {
    expect(
      deriveSessionIndicatorState({ ...idleInput(), pendingPromptCount: 2 }),
    ).toEqual({ kind: 'needs-input', promptCount: 2, promptTypes: [] });
  });

  it('fails safe to one prompt when only the durable boolean is available', () => {
    expect(
      deriveSessionIndicatorState({
        ...idleInput(),
        hasPendingInteractivePrompt: true,
      }),
    ).toEqual({ kind: 'needs-input', promptCount: 1, promptTypes: [] });
  });

  it('reports background work alongside an active lead', () => {
    expect(
      deriveSessionIndicatorState({
        ...idleInput(),
        isLeadProcessing: true,
        hasChildProcessing: true,
        childProcessingCount: 3,
      }),
    ).toEqual({
      kind: 'working-self',
      hasBackground: true,
      backgroundCount: 3,
    });
  });
});

function groupInput(
  patch: Partial<GroupIndicatorInput> = {},
): GroupIndicatorInput {
  return {
    ...idleInput(),
    directChildProcessingCount: 0,
    ...patch,
  };
}

describe('aggregateChildInputs', () => {
  it('preserves a parent-only state', () => {
    const result = aggregateChildInputs(groupInput({ hasUnread: true }), []);
    expect(deriveSessionIndicatorState(result)).toEqual({ kind: 'ready' });
  });

  it('treats a processing child as steady background work, not the group lead', () => {
    const result = aggregateChildInputs(
      groupInput(),
      [groupInput({ isLeadProcessing: true })],
    );
    expect(deriveSessionIndicatorState(result)).toEqual({
      kind: 'working-child',
      childCount: 1,
    });
  });

  it('does not double count a child already represented by the parent input', () => {
    const result = aggregateChildInputs(
      groupInput({
        hasChildProcessing: true,
        childProcessingCount: 1,
        directChildProcessingCount: 1,
      }),
      [groupInput({ isLeadProcessing: true })],
    );
    expect(result.childProcessingCount).toBe(1);
  });

  it('adds nested background work to the parent background count', () => {
    const result = aggregateChildInputs(
      groupInput({
        hasChildProcessing: true,
        childProcessingCount: 1,
        directChildProcessingCount: 1,
      }),
      [groupInput({ hasChildProcessing: true, childProcessingCount: 2 })],
    );
    expect(result.childProcessingCount).toBe(3);
  });

  it('keeps parent lead precedence while retaining the background count', () => {
    const result = aggregateChildInputs(
      groupInput({ isLeadProcessing: true }),
      [groupInput({ isLeadProcessing: true })],
    );
    expect(deriveSessionIndicatorState(result)).toEqual({
      kind: 'working-self',
      hasBackground: true,
      backgroundCount: 1,
    });
  });

  it('counts durable prompt booleans when identities have not hydrated yet', () => {
    const result = aggregateChildInputs(
      groupInput({ hasPendingInteractivePrompt: true }),
      [groupInput({ hasPendingInteractivePrompt: true })],
    );
    expect(deriveSessionIndicatorState(result)).toEqual({
      kind: 'needs-input',
      promptCount: 2,
      promptTypes: [],
    });
  });

  it('retains the winning child wakeup details', () => {
    const result = aggregateChildInputs(groupInput(), [
      groupInput({
        hasWakeupAttention: true,
        wakeupReason: 'Open the workspace',
        wakeupFireAt: 1234,
        wakeupStatus: 'waiting_for_workspace',
      }),
    ]);
    expect(deriveSessionIndicatorState(result)).toEqual({
      kind: 'wakeup-attention',
      reason: 'Open the workspace',
      fireAt: 1234,
      status: 'waiting_for_workspace',
    });
  });

  it('uses the same precedence for mixed parent and child inputs', () => {
    const result = aggregateChildInputs(
      groupInput({ hasUnread: true }),
      [groupInput({ queuedPromptCount: 2 })],
    );
    expect(deriveSessionIndicatorState(result)).toEqual({
      kind: 'queued',
      queuedCount: 2,
    });
  });
});
