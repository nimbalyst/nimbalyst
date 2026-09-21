import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptProjector';
import deepEqual from 'fast-deep-equal';

/** Missing tags are legacy data, never authority over a tagged generation. */
export function latestTranscriptGeneration(
  messages: readonly { transcriptGeneration?: number }[],
): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    const generation = message.transcriptGeneration;
    if (generation !== undefined && Number.isSafeInteger(generation) && generation > 0)
      latest = Math.max(latest ?? 0, generation);
  }
  return latest;
}

/** Capture mutable streaming text before an awaited snapshot request. */
export function captureTranscriptMessages(
  messages: readonly TranscriptViewMessage[],
): TranscriptViewMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.toolCall ? { toolCall: { ...message.toolCall } } : {}),
  }));
}

export function reconcileTranscriptMessages(
  current: readonly TranscriptViewMessage[],
  incoming: readonly TranscriptViewMessage[],
  options: { stream?: boolean; startedWith?: readonly TranscriptViewMessage[] } = {},
): TranscriptViewMessage[] {
  const currentGeneration = latestTranscriptGeneration(current);
  const incomingGeneration = latestTranscriptGeneration(incoming);
  const generation = Math.max(currentGeneration ?? 0, incomingGeneration ?? 0) || undefined;
  // An empty array cannot identify a generation. It therefore cannot erase
  // newer tagged data. Initially empty and legacy-only snapshots stay usable.
  const accepts = (message: TranscriptViewMessage) =>
    message.id >= 0 && (generation === undefined || message.transcriptGeneration === generation);
  const canonical = new Map<number, TranscriptViewMessage>();
  const started = new Map(options.startedWith?.map((message) => [message.id, message]));
  const staleSnapshot =
    currentGeneration !== undefined && (incomingGeneration ?? 0) < currentGeneration;
  // A full snapshot replaces its requested baseline: projection may have fused
  // several prior rows into one. Retain only post-request additions/updates,
  // except when the entire snapshot belongs to an obsolete generation.
  for (const message of current) {
    if (
      accepts(message) &&
      (options.stream ||
        staleSnapshot ||
        (options.startedWith && !deepEqual(message, started.get(message.id))))
    )
      canonical.set(message.id, message);
  }
  for (const message of incoming) {
    if (!accepts(message)) continue;
    const live = canonical.get(message.id);
    // A snapshot requested before an in-place streamed text/tool update must
    // not roll that update back. IDs are compared only within one generation.
    if (
      !options.stream &&
      live &&
      options.startedWith &&
      live.transcriptGeneration === message.transcriptGeneration &&
      !deepEqual(live, started.get(message.id))
    )
      continue;
    canonical.set(message.id, message);
  }
  const ordered = [...canonical.values()].sort((a, b) => a.sequence - b.sequence || a.id - b.id);
  const optimistic = new Map<number, TranscriptViewMessage>();
  for (const message of [...current, ...incoming])
    if (message.id < 0) optimistic.set(message.id, message);

  // Preserve the existing bounded timestamp match for optimistic input only;
  // canonical messages are never deduplicated by text. One persisted input
  // acknowledges at most one pending copy, and an already-present input is
  // not reused to acknowledge another identical request on subsequent polls.
  const priorUsers = current.filter(
    (message) => message.id >= 0 && message.type === 'user_message',
  );
  const acknowledgements = ordered.filter(
    (message) =>
      message.type === 'user_message' &&
      !priorUsers.some(
        (prior) =>
          prior.id === message.id && prior.transcriptGeneration === message.transcriptGeneration,
      ),
  );
  const pending = [...optimistic.values()].filter((message) => {
    const match = acknowledgements.findIndex(
      (persisted) =>
        persisted.type === message.type &&
        optimisticAcknowledgmentText(persisted.text) ===
          optimisticAcknowledgmentText(message.text) &&
        Math.abs(messageTime(persisted) - messageTime(message)) < 5000,
    );
    if (match < 0) return true;
    acknowledgements.splice(match, 1);
    return false;
  });
  return [...ordered, ...pending];
}

/** Match the display/history rule in sessions.ts stripSystemMessageAdditions.
 * Only acknowledgment comparisons use this; canonical and pending text stay intact.
 */
function optimisticAcknowledgmentText(content: string | undefined): string | undefined {
  return content
    ?.replace(/\s*<NIMBALYST_SYSTEM_MESSAGE>[\s\S]*?<\/NIMBALYST_SYSTEM_MESSAGE>/g, '')
    .trim();
}

function messageTime(message: TranscriptViewMessage): number {
  const value: unknown = message.createdAt;
  return value instanceof Date
    ? value.getTime()
    : typeof value === 'string'
    ? Date.parse(value)
    : 0;
}
