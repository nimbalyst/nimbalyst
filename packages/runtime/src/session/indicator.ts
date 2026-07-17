/**
 * Authoritative session operational/attention state resolver.
 *
 * Derives exactly one mutually exclusive state from a fixed set of
 * observable inputs. Collision rules follow the locked normal precedence:
 *
 *   1. unresolved human action  (needs-input)
 *   2. current error            (error)
 *   3. lead work                (working-self)
 *   4. background child work    (working-child)
 *   5. real queued prompt       (queued)
 *   6. unread terminal result   (ready)
 *   7. wakeup attention         (wakeup-attention)
 *   8. future scheduled wakeup  (scheduled)
 *   9. idle                     (idle)
 *
 * See the dispatch brief for the full collision contract.
 */

// ---------------------------------------------------------------------------
// Inputs (what the resolver needs — decoupled from any state library)
// ---------------------------------------------------------------------------

export interface SessionIndicatorInputs {
  /** One or more unresolved durable interactive prompt identities exist. */
  hasPendingInteractivePrompt: boolean;
  /** Count of pending-prompt identities (for the tooltip / label). */
  pendingPromptCount: number;
  /** Durable prompt identity types, used for exact accessible wording. */
  pendingPromptTypes: readonly string[];
  /** The lead model is actively processing (streaming). */
  isLeadProcessing: boolean;
  /** At least one direct child / teammate / sub-agent task is running. */
  hasChildProcessing: boolean;
  /** Count of genuinely running child/teammate/task entries. */
  childProcessingCount: number;
  /** Count of real queued prompts in the queue. */
  queuedPromptCount: number;
  /** Terminal output is unread after active/queued work clears. */
  hasUnread: boolean;
  /** Latest turn/wakeup produced an error */
  hasError: boolean;
  /** Safe error category string (or empty). */
  errorMessage: string;
  /** A wakeup is overdue or waiting on a user-fixable condition. */
  hasWakeupAttention: boolean;
  /** Future wakeup is pending. */
  hasScheduledWakeup: boolean;
  /** Human-readable wakeup reason for tooltips. */
  wakeupReason: string | null;
  /** Fire time (ms epoch) for scheduled wakeup tooltips. */
  wakeupFireAt: number | null;
  /** Wakeup status string. */
  wakeupStatus: string | null;
}

// ---------------------------------------------------------------------------
// Discriminated union (the output)
// ---------------------------------------------------------------------------

export type SessionIndicatorState =
  | { readonly kind: 'needs-input'; promptCount: number; promptTypes: readonly string[] }
  | { readonly kind: 'error'; message: string }
  | { readonly kind: 'working-self'; hasBackground: boolean; backgroundCount: number }
  | { readonly kind: 'working-child'; childCount: number }
  | { readonly kind: 'queued'; queuedCount: number }
  | { readonly kind: 'ready' }
  | { readonly kind: 'wakeup-attention'; reason: string | null; fireAt: number | null; status: string | null }
  | { readonly kind: 'scheduled'; reason: string | null; fireAt: number | null }
  | { readonly kind: 'idle' };

// ---------------------------------------------------------------------------
// Pure resolver
// ---------------------------------------------------------------------------

/**
 * Derive the single operational indicator state from the given inputs.
 *
 * The precedence order is locked by the feature specification. The function
 * is pure and has no side effects — callers must provide all inputs.
 *
 * Collision rules:
 * - A real interactive prompt wins over tail-end streaming.
 * - If terminal error and a prompt coexist, prefer the newest authoritative
 *   event. Since we have no sequence here, fail safe to needs-input.
 * - Lead work wins over background-only presentation.
 * - Work wins over unread. When all work clears, unread becomes ready.
 * - ready wins over a passive future schedule.
 * - Phase complete never suppresses new operation or attention state.
 */
export function deriveSessionIndicatorState(
  inputs: SessionIndicatorInputs,
): SessionIndicatorState {
  // 1. Unresolved human action
  if (inputs.hasPendingInteractivePrompt || inputs.pendingPromptCount > 0) {
    return {
      kind: 'needs-input',
      promptCount: Math.max(inputs.pendingPromptCount, 1),
      promptTypes: inputs.pendingPromptTypes,
    };
  }

  // 2. Current error
  if (inputs.hasError) {
    return { kind: 'error', message: inputs.errorMessage };
  }

  // 3. Lead work (wins over background-only)
  if (inputs.isLeadProcessing) {
    const backgroundCount = Math.max(
      inputs.childProcessingCount,
      inputs.hasChildProcessing ? 1 : 0,
    );
    return {
      kind: 'working-self',
      hasBackground: backgroundCount > 0,
      backgroundCount,
    };
  }

  // 4. Background child/teammate/task work
  if (inputs.hasChildProcessing || inputs.childProcessingCount > 0) {
    return {
      kind: 'working-child',
      childCount: Math.max(inputs.childProcessingCount, 1),
    };
  }

  // 5. Real queued prompt
  if (inputs.queuedPromptCount > 0) {
    return { kind: 'queued', queuedCount: inputs.queuedPromptCount };
  }

  // 6. Unread terminal result
  if (inputs.hasUnread) {
    return { kind: 'ready' };
  }

  // 7. Wakeup attention (overdue / waiting_on_workspace)
  if (inputs.hasWakeupAttention) {
    return {
      kind: 'wakeup-attention',
      reason: inputs.wakeupReason,
      fireAt: inputs.wakeupFireAt,
      status: inputs.wakeupStatus,
    };
  }

  // 8. Future scheduled wakeup
  if (inputs.hasScheduledWakeup) {
    return {
      kind: 'scheduled',
      reason: inputs.wakeupReason,
      fireAt: inputs.wakeupFireAt,
    };
  }

  // 9. Idle
  return { kind: 'idle' };
}

// ---------------------------------------------------------------------------
// Group derivation (parent + child IDs, same precedence)
// ---------------------------------------------------------------------------

export interface GroupIndicatorInput {
  hasPendingInteractivePrompt: boolean;
  pendingPromptCount: number;
  pendingPromptTypes: readonly string[];
  isLeadProcessing: boolean;
  hasChildProcessing: boolean;
  childProcessingCount: number;
  queuedPromptCount: number;
  hasUnread: boolean;
  hasError: boolean;
  errorMessage: string;
  hasWakeupAttention: boolean;
  hasScheduledWakeup: boolean;
  wakeupReason: string | null;
  wakeupFireAt: number | null;
  wakeupStatus: string | null;
  /** Processing direct child sessions already included in childProcessingCount. */
  directChildProcessingCount?: number;
}

/**
 * Aggregate child indicator inputs into a single input object by OR-ing
 * booleans and summing counts. The result can be passed to
 * `deriveSessionIndicatorState` to get the group's resolved state.
 */
export function aggregateChildInputs(
  parent: GroupIndicatorInput,
  children: GroupIndicatorInput[],
): SessionIndicatorInputs {
  if (children.length === 0) {
    return toInputs(parent);
  }

  const childLeadCount = children.filter((child) => child.isLeadProcessing).length;
  const accountedChildLeads = parent.directChildProcessingCount ?? 0;
  const unaccountedChildLeads = Math.max(0, childLeadCount - accountedChildLeads);
  const nestedBackgroundCount = children.reduce(
    (sum, child) => sum + child.childProcessingCount,
    0,
  );
  const childProcessingCount =
    parent.childProcessingCount + nestedBackgroundCount + unaccountedChildLeads;

  const wakeupAttentionSource = parent.hasWakeupAttention
    ? parent
    : children.find((child) => child.hasWakeupAttention);
  const scheduledWakeupSource = parent.hasScheduledWakeup
    ? parent
    : children.find((child) => child.hasScheduledWakeup);
  const wakeupSource = wakeupAttentionSource ?? scheduledWakeupSource;

  // The parent is the group's lead. A processing child is background work,
  // never a second lead spinner for the collapsed parent row.
  return {
    hasPendingInteractivePrompt:
      parent.hasPendingInteractivePrompt || children.some((c) => c.hasPendingInteractivePrompt),
    pendingPromptCount:
      Math.max(parent.pendingPromptCount, parent.hasPendingInteractivePrompt ? 1 : 0)
      + children.reduce(
        (sum, child) => sum + Math.max(
          child.pendingPromptCount,
          child.hasPendingInteractivePrompt ? 1 : 0,
        ),
        0,
      ),
    pendingPromptTypes: Array.from(new Set([
      ...parent.pendingPromptTypes,
      ...children.flatMap((child) => child.pendingPromptTypes),
    ])),
    isLeadProcessing: parent.isLeadProcessing,
    hasChildProcessing: childProcessingCount > 0,
    childProcessingCount,
    queuedPromptCount:
      parent.queuedPromptCount + children.reduce((s, c) => s + c.queuedPromptCount, 0),
    hasUnread:
      parent.hasUnread || children.some((c) => c.hasUnread),
    hasError:
      parent.hasError || children.some((c) => c.hasError),
    errorMessage:
      parent.errorMessage || children.find((c) => c.hasError)?.errorMessage || '',
    hasWakeupAttention:
      parent.hasWakeupAttention || children.some((c) => c.hasWakeupAttention),
    hasScheduledWakeup:
      parent.hasScheduledWakeup || children.some((c) => c.hasScheduledWakeup),
    wakeupReason: wakeupSource?.wakeupReason ?? null,
    wakeupFireAt: wakeupSource?.wakeupFireAt ?? null,
    wakeupStatus: wakeupSource?.wakeupStatus ?? null,
  };
}

function toInputs(g: GroupIndicatorInput): SessionIndicatorInputs {
  return {
    hasPendingInteractivePrompt: g.hasPendingInteractivePrompt,
    pendingPromptCount: g.pendingPromptCount,
    pendingPromptTypes: g.pendingPromptTypes,
    isLeadProcessing: g.isLeadProcessing,
    hasChildProcessing: g.hasChildProcessing,
    childProcessingCount: g.childProcessingCount,
    queuedPromptCount: g.queuedPromptCount,
    hasUnread: g.hasUnread,
    hasError: g.hasError,
    errorMessage: g.errorMessage,
    hasWakeupAttention: g.hasWakeupAttention,
    hasScheduledWakeup: g.hasScheduledWakeup,
    wakeupReason: g.wakeupReason,
    wakeupFireAt: g.wakeupFireAt,
    wakeupStatus: g.wakeupStatus,
  };
}
