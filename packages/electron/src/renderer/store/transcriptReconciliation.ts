import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptProjector';
import deepEqual from 'fast-deep-equal';

/** Keep unchanged rows stable even when projection adds, removes or moves rows. */
export function preserveTranscriptMessageIdentity(
  current: TranscriptViewMessage[],
  next: TranscriptViewMessage[],
): TranscriptViewMessage[] {
  if (current === next) return current;
  const previousById = new Map(current.map(message => [message.id, message]));
  let unchanged = current.length === next.length;
  const messages = next.map((message, index) => {
    const previous = previousById.get(message.id);
    // Equality includes generation, sequence and all tool/metadata fields:
    // matching text alone must never hide a real update or a rebuilt generation.
    const retained = previous && deepEqual(previous, message) ? previous : message;
    if (retained !== current[index]) unchanged = false;
    return retained;
  });
  return unchanged ? current : messages;
}

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

  // Match optimistic input only; canonical messages are never deduplicated by
  // text. One persisted input acknowledges at most one pending copy, and an
  // already-present input is not reused to acknowledge another identical
  // request on subsequent polls. There is no upper bound on the delay: the
  // provider persists the prompt only after turn setup, which can take many
  // seconds, and a missed match would pin the copy below the transcript
  // (#1620). The persisted input must not predate the send, so a rebuilt
  // generation cannot let an earlier identical prompt acknowledge a new one.
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
  // A local error row has no saved twin to acknowledge it. Keep it while it is
  // the latest thing in the transcript and retire it once a later row is saved;
  // otherwise it stays pinned below every later turn (#1663).
  const newestCanonical = ordered.reduce((newest, message) => {
    const time = messageTime(message);
    return time > newest ? time : newest;
  }, 0);
  // A copy no saved row acknowledged (its send failed, or a retry of the same
  // text acknowledged the failed copy instead) is orphaned once a later prompt
  // has been saved and answered: sends are serial, so nothing saved can still
  // be on its way for it. Without this it stays pinned below every turn (#1608).
  const newestReply = ordered.reduce((newest, message) => {
    const time = messageTime(message);
    return message.type !== 'user_message' && time > newest ? time : newest;
  }, 0);
  const answeredPrompt = ordered.reduce((newest, message) => {
    const time = messageTime(message);
    return message.type === 'user_message' && time < newestReply && time > newest ? time : newest;
  }, 0);
  const pending = [...optimistic.values()].filter((message) => {
    if (message.type !== 'user_message') return messageTime(message) >= newestCanonical;
    const match = acknowledgements.findIndex(
      (persisted) =>
        persisted.type === message.type &&
        optimisticAcknowledgmentText(persisted.text) ===
          optimisticAcknowledgmentText(message.text) &&
        messageTime(persisted) >= messageTime(message),
    );
    if (match < 0) return messageTime(message) >= answeredPrompt;
    acknowledgements.splice(match, 1);
    return false;
  });
  return [...ordered, ...pending];
}

export type TranscriptMergePath = 'stream' | 'load' | 'reload' | 'update';

const reportedDuplicatePrompts = new Set<string>();

/**
 * Diagnostic for #919: under load a session's first prompt showed a second
 * time at the bottom of the transcript, with the saved prompt's timestamp,
 * until the next full reload. Names the merge path that produced the list,
 * once per session, path and duplicate.
 *
 * Two user messages are the same prompt when they share an id, or their text
 * and timestamp. Sending the same text again gets a new timestamp, so it is
 * not flagged. Generation is not compared: a copy from a retired generation
 * is a suspect. The text is compared but never logged.
 */
export function warnOnDuplicateUserPrompt(
  sessionId: string,
  mergePath: TranscriptMergePath,
  messages: readonly TranscriptViewMessage[],
): void {
  const indexById = new Map<number, number>();
  const indexByTimeAndText = new Map<number, Map<string | undefined, number>>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.type !== 'user_message') continue;
    const time = messageTime(message);
    let sameTime = indexByTimeAndText.get(time);
    if (!sameTime) indexByTimeAndText.set(time, (sameTime = new Map()));
    const first = indexById.get(message.id) ?? sameTime.get(message.text);
    if (!indexById.has(message.id)) indexById.set(message.id, index);
    if (!sameTime.has(message.text)) sameTime.set(message.text, index);
    if (first === undefined) continue;

    const original = messages[first];
    const key = `${sessionId}|${mergePath}|${original.id}:${original.transcriptGeneration}|${message.id}:${message.transcriptGeneration}`;
    if (reportedDuplicatePrompts.has(key)) continue;
    reportedDuplicatePrompts.add(key);
    console.warn(`[transcriptReconciliation] Duplicate user prompt after ${mergePath} merge (#919) ${JSON.stringify({
      sessionId,
      mergePath,
      length: messages.length,
      ids: [original.id, message.id],
      indices: [first, index],
      transcriptGenerations: [original.transcriptGeneration ?? null, message.transcriptGeneration ?? null],
      sequences: [original.sequence, message.sequence],
      createdAt: [messageTime(original), time],
    })}`);
  }
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
