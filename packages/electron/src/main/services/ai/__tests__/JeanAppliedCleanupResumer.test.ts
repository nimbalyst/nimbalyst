import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertMainProcessImportProofHarnessDrained,
  mainProcessImportProofModules,
  resetMainProcessImportProofHarness,
} from '../../../__tests__/mainProcessImportProofHarness';

vi.mock('electron', () => mainProcessImportProofModules.electron);
vi.mock('../../../window/WindowManager', () => mainProcessImportProofModules.windowManager);
vi.mock('../../../utils/logger', () => mainProcessImportProofModules.logger);
vi.mock('electron-log/main', () => mainProcessImportProofModules.electronLog);
vi.mock('../../../analytics/AnalyticsService', () => mainProcessImportProofModules.analytics);
vi.mock('electron-store', () => mainProcessImportProofModules.electronStore);

import { createAppliedJeanCleanupResumer } from '../JeanAppliedCleanupResumer';

beforeEach(() => {
  resetMainProcessImportProofHarness();
});

afterEach(() => {
  assertMainProcessImportProofHarnessDrained();
  resetMainProcessImportProofHarness();
});

const identity = {
  sessionId: 'session-a', eventIdentity: 'p1', attentionGeneration: 'generation-a',
  receiptId: 'receipt-a', reservationOwner: 'owner-a', mutationId: 'mutation-a', mutationFence: 7,
};

function authority(overrides: Record<string, unknown> = {}) {
  let attentionClaims = 0;
  return {
    metadataCleanupAuthority: vi.fn((step: 'prompt' | 'attention', attentionGeneration: string) => ({
      receiptId: identity.receiptId, reservationOwner: identity.reservationOwner,
      mutationId: identity.mutationId, mutationFence: identity.mutationFence,
      attentionGeneration, step,
    })),
    claimCleanupStep: vi.fn(async (step: string) => {
      if (step !== 'attention') return { status: 'claimed' as const };
      attentionClaims += 1;
      return attentionClaims === 1
        ? { status: 'claimed' as const }
        : { status: 'complete' as const, attentionResult: 'settled' as const };
    }),
    ...overrides,
  } as any;
}

describe('JeanAppliedCleanupResumer', () => {
  it('resumes a durably applied A without provider/native entry and reports stored exact-A settlement', async () => {
    const completePromptCleanup = vi.fn(async () => 'complete' as const);
    const cancelInteractivePrompt = vi.fn(async () => ({
      attentionCancelledCount: 1 as const, attentionResult: 'settled' as const,
    }));
    const resumer = createAppliedJeanCleanupResumer({ completePromptCleanup, cancelInteractivePrompt: cancelInteractivePrompt as any });
    await expect(resumer.resume({ identity, mutationAuthority: authority(), cancelReason: 'answered' })).resolves.toEqual({
      status: 'complete', attentionResult: 'settled', attentionCancelledCount: 1,
      eventCleared: true, cleanupVerified: true,
    });
    expect(completePromptCleanup).toHaveBeenCalledWith(expect.objectContaining({ eventIdentity: 'p1', attentionGeneration: 'generation-a' }));
    expect(cancelInteractivePrompt).toHaveBeenCalledOnce();
  });

  it('fails closed before either cleanup side effect when receipt ownership is not exact', async () => {
    const completePromptCleanup = vi.fn(async () => 'complete' as const);
    const cancelInteractivePrompt = vi.fn();
    const resumer = createAppliedJeanCleanupResumer({ completePromptCleanup, cancelInteractivePrompt: cancelInteractivePrompt as any });
    const mutationAuthority = authority({ metadataCleanupAuthority: () => ({
      receiptId: 'other', reservationOwner: identity.reservationOwner, mutationId: identity.mutationId,
      mutationFence: identity.mutationFence, attentionGeneration: identity.attentionGeneration, step: 'prompt',
    }) });
    await expect(resumer.resume({ identity, mutationAuthority, cancelReason: 'answered' })).resolves.toMatchObject({ status: 'not_owned' });
    expect(completePromptCleanup).not.toHaveBeenCalled();
    expect(cancelInteractivePrompt).not.toHaveBeenCalled();
  });

  it('does not publish the observed hook after post-commit authority loss', async () => {
    const completePromptCleanup = vi.fn(async () => 'complete' as const);
    const cancelInteractivePrompt = vi.fn(async () => ({ attentionCancelledCount: 1 as const, attentionResult: 'settled' as const }));
    const claimCleanupStep = vi.fn(async (step: string) => {
      if (step === 'prompt') return { status: 'claimed' as const };
      return claimCleanupStep.mock.calls.filter(([claimed]) => claimed === 'attention').length === 1
        ? { status: 'claimed' as const }
        : false;
    });
    const mutationAuthority = authority({ claimCleanupStep });
    const observed = vi.fn();
    const resumer = createAppliedJeanCleanupResumer({ completePromptCleanup, cancelInteractivePrompt: cancelInteractivePrompt as any });
    await expect(resumer.resume({
      identity, mutationAuthority, cancelReason: 'answered',
      hooks: { afterAttentionMetadataCommitted: async () => undefined, afterAttentionPhaseObserved: observed },
    })).resolves.toMatchObject({ status: 'not_owned' });
    expect(claimCleanupStep).toHaveBeenCalledTimes(3);
    expect(observed).not.toHaveBeenCalled();
  });
});
