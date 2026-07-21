import {
  attentionEventService,
  type DurableAttentionCancellationOutcome,
} from '../AttentionEventService';
import type { HostControlReceiptMutationAuthority } from '../HostControlReceiptsStore';
import { completeAppliedJeanPromptCleanup } from './pendingPromptPersistence';

export interface AppliedJeanCleanupIdentity {
  sessionId: string;
  eventIdentity: string;
  attentionGeneration: string;
  receiptId: string;
  reservationOwner: string;
  mutationId: string;
  mutationFence: number;
}

export interface AppliedJeanCleanupHooks {
  afterPromptPhaseCommitted?: () => Promise<void>;
  afterAttentionMetadataCommitted?: () => Promise<void>;
  afterAttentionPhaseObserved?: () => Promise<void>;
}

export type AppliedJeanCleanupOutcome =
  | { status: 'complete'; attentionResult: 'settled' | 'already_absent'; attentionCancelledCount: 0 | 1; eventCleared: boolean; cleanupVerified: true }
  | { status: 'not_owned' | 'failed'; errorClass: 'cleanup_authority_lost' | 'cleanup_state_invalid' | 'cleanup_persistence_failed'; cleanupVerified: false };

export interface AppliedJeanCleanupResumerInput {
  identity: AppliedJeanCleanupIdentity;
  mutationAuthority: HostControlReceiptMutationAuthority;
  cancelReason: 'answered' | 'cancelled';
  hooks?: AppliedJeanCleanupHooks;
}

export interface AppliedJeanCleanupResumer {
  resume(input: AppliedJeanCleanupResumerInput): Promise<AppliedJeanCleanupOutcome>;
}

export interface AppliedJeanCleanupResumerDependencies {
  completePromptCleanup?: typeof completeAppliedJeanPromptCleanup;
  cancelInteractivePrompt?: (
    sessionId: string,
    promptIdentity: string,
    reason: 'answered' | 'cancelled',
    options: {
      expectedGeneration: string;
      durableCleanupAuthority: ReturnType<HostControlReceiptMutationAuthority['metadataCleanupAuthority']>;
    },
  ) => Promise<DurableAttentionCancellationOutcome>;
}

function owns(identity: AppliedJeanCleanupIdentity, authority: ReturnType<HostControlReceiptMutationAuthority['metadataCleanupAuthority']>): boolean {
  return authority.receiptId === identity.receiptId
    && authority.reservationOwner === identity.reservationOwner
    && authority.mutationId === identity.mutationId
    && authority.mutationFence === identity.mutationFence
    && authority.attentionGeneration === identity.attentionGeneration;
}

export function createAppliedJeanCleanupResumer(
  deps: AppliedJeanCleanupResumerDependencies = {},
): AppliedJeanCleanupResumer {
  // The production singleton outlives repository/facade reconstruction. Keep
  // its default collaborators late-bound so resumed cleanup uses the currently
  // installed service lifecycle rather than methods captured at module load.
  const completePromptCleanup = deps.completePromptCleanup
    ?? ((input: Parameters<typeof completeAppliedJeanPromptCleanup>[0]) => (
      completeAppliedJeanPromptCleanup(input)
    ));
  const cancelInteractivePrompt = deps.cancelInteractivePrompt
    ?? ((sessionId, promptIdentity, reason, options) => (
      attentionEventService.cancelInteractivePrompt(sessionId, promptIdentity, reason, options)
    ));
  return {
    async resume(input) {
      const { identity, mutationAuthority, hooks } = input;
      const promptAuthority = mutationAuthority.metadataCleanupAuthority('prompt', identity.attentionGeneration);
      if (!owns(identity, promptAuthority)) return { status: 'not_owned', errorClass: 'cleanup_authority_lost', cleanupVerified: false };
      const prompt = await mutationAuthority.claimCleanupStep('prompt', identity.attentionGeneration);
      if (!prompt) return { status: 'not_owned', errorClass: 'cleanup_authority_lost', cleanupVerified: false };
      if (prompt.status === 'claimed') {
        let promptResult: 'complete' | 'not_owned' | 'invalid_state';
        try {
          promptResult = await completePromptCleanup({
            sessionId: identity.sessionId,
            eventIdentity: identity.eventIdentity,
            attentionGeneration: identity.attentionGeneration,
            durableCleanupAuthority: promptAuthority,
          });
        } catch {
          return { status: 'failed', errorClass: 'cleanup_persistence_failed', cleanupVerified: false };
        }
        if (promptResult === 'not_owned') return { status: 'not_owned', errorClass: 'cleanup_authority_lost', cleanupVerified: false };
        if (promptResult !== 'complete') return { status: 'failed', errorClass: 'cleanup_state_invalid', cleanupVerified: false };
        await hooks?.afterPromptPhaseCommitted?.();
      }
      const attentionAuthority = mutationAuthority.metadataCleanupAuthority('attention', identity.attentionGeneration);
      if (!owns(identity, attentionAuthority)) return { status: 'not_owned', errorClass: 'cleanup_authority_lost', cleanupVerified: false };
      const attention = await mutationAuthority.claimCleanupStep('attention', identity.attentionGeneration);
      if (!attention) return { status: 'not_owned', errorClass: 'cleanup_authority_lost', cleanupVerified: false };
      let attentionResult: 'settled' | 'already_absent';
      if (attention.status === 'complete') {
        if (!attention.attentionResult) return { status: 'failed', errorClass: 'cleanup_state_invalid', cleanupVerified: false };
        attentionResult = attention.attentionResult;
      } else {
        const outcome = await cancelInteractivePrompt(identity.sessionId, identity.eventIdentity, input.cancelReason, {
          expectedGeneration: identity.attentionGeneration,
          durableCleanupAuthority: attentionAuthority,
        });
        if (!outcome.attentionResult) return { status: 'failed', errorClass: 'cleanup_persistence_failed', cleanupVerified: false };
        attentionResult = outcome.attentionResult;
        await hooks?.afterAttentionMetadataCommitted?.();
      }
      // A hook may await long enough for this owner to expire. Re-observe the
      // immutable completed phase under current DB-time authority before any
      // post-phase continuation can be attributed to this owner.
      const observed = await mutationAuthority.claimCleanupStep('attention', identity.attentionGeneration);
      if (!observed) return { status: 'not_owned', errorClass: 'cleanup_authority_lost', cleanupVerified: false };
      if (observed.status !== 'complete' || observed.attentionResult !== attentionResult) {
        return { status: 'failed', errorClass: 'cleanup_state_invalid', cleanupVerified: false };
      }
      await hooks?.afterAttentionPhaseObserved?.();
      return {
        status: 'complete', attentionResult,
        attentionCancelledCount: attentionResult === 'settled' ? 1 : 0,
        eventCleared: attentionResult === 'settled', cleanupVerified: true,
      };
    },
  };
}

export const appliedJeanCleanupResumer = createAppliedJeanCleanupResumer();
