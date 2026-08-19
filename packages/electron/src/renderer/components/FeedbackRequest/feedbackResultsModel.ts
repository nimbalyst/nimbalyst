/**
 * The author's read of a feedback request, computed once per snapshot.
 *
 * Everything the results surface draws comes from `buildFeedbackResults`. The
 * component picks nothing out of the request itself, which is what keeps the
 * two rules below in one place instead of scattered across JSX:
 *
 * - **Response attribution is server-projected.** The client renders the
 *   optional `recipientUserId` it receives and never strips one itself. That
 *   keeps a server projection regression visible to tests instead of masking
 *   it in one UI while another client can still observe the raw response.
 *   Visibility still controls whether the client may derive an outstanding
 *   recipient list from assignments.
 * - **Counting is done once.** One pass groups responses by ask; recipient
 *   names come from a Map built once. Nothing here is called per render row.
 */

import type {
  FeedbackAsk,
  FeedbackAskArtifact,
  FeedbackRequestProgress,
  FeedbackRequestReadModel,
  FeedbackResponseReadModel,
} from '@nimbalyst/collab-protocol';

// Deep path, not the Comments barrel: this module wants one string helper and
// the barrel drags the composer's Lexical tree in behind it.
import { initialsFor } from '../Comments/commentBodyParser';

export interface FeedbackResultsVoter {
  userId: string;
  name: string;
  initials: string;
}

export interface FeedbackChoiceOptionTally {
  optionId: string;
  label: string;
  description?: string;
  count: number;
  /** 0-100, of the people who answered this ask. */
  percent: number;
  /** Strictly ahead of every other option; a tie has no leader. */
  isLeader: boolean;
  /** Empty on a hidden request, always. */
  voters: FeedbackResultsVoter[];
  /**
   * The resource this option stood for, when one was bound. "B won" is not an
   * answer the author can act on unless B is still reachable from the result.
   */
  artifact?: FeedbackAskArtifact;
}

export interface FeedbackChoiceResult {
  kind: 'choice';
  options: FeedbackChoiceOptionTally[];
  /** Free text typed into an `allowOther` option, kept rather than dropped. */
  otherNotes: Array<{ id: string; text: string; author: FeedbackResultsVoter | null }>;
}

export interface FeedbackRankedEntry {
  itemId: string;
  title: string;
  /** 1-based consolidated position. */
  rank: number;
  /** How many orderings put this item in each 1-based position. */
  positionCounts: number[];
  /** Mean 1-based position across the orderings that ranked it. */
  meanPosition: number;
  firstPlaceCount: number;
  lastPlaceCount: number;
  rankedByCount: number;
  /** As on a choice tally: the ranked thing, when the ask bound one. */
  artifact?: FeedbackAskArtifact;
  contested: boolean;
  /** The line the author reads instead of the mean. */
  summary: string;
}

export interface FeedbackRankedResult {
  kind: 'ranked';
  entries: FeedbackRankedEntry[];
  orderingCount: number;
  /** Longest ordering seen, so the spread axis knows how many buckets to draw. */
  positionCount: number;
}

export interface FeedbackTextAnswer {
  id: string;
  text: string;
  author: FeedbackResultsVoter | null;
  answeredAt: number;
}

export interface FeedbackTextResult {
  kind: 'text';
  answers: FeedbackTextAnswer[];
}

export interface FeedbackRatingResult {
  kind: 'rating';
  mean: number;
  lowest: number;
  highest: number;
  count: number;
  scaleMin: number;
  scaleMax: number;
}

export type FeedbackAskResultDetail =
  | FeedbackChoiceResult
  | FeedbackRankedResult
  | FeedbackTextResult
  | FeedbackRatingResult;

export interface FeedbackAskResult {
  ask: FeedbackAsk;
  /** 1-based, in the request's own ask order, so Q-numbers stay stable. */
  index: number;
  answeredCount: number;
  assignedCount: number;
  detail: FeedbackAskResultDetail;
}

export interface FeedbackOutstandingPerson {
  userId: string;
  name: string;
  initials: string;
  /** Ask labels this person still owes, in the request's ask order. */
  pendingAskLabels: string[];
}

/**
 * Named only on an attributed request.
 *
 * On a hidden request the client genuinely cannot compute this -- responses
 * arrive with no recipient -- and it should not want to: with two recipients
 * and one anonymous answer in, naming the person still outstanding identifies
 * the other one's vote exactly. So the hidden case carries a count and chases
 * through the server, which knows who is missing without telling the author.
 */
export type FeedbackOutstanding =
  | { kind: 'named'; count: number; people: FeedbackOutstandingPerson[] }
  | { kind: 'anonymous'; count: number | null };

export interface FeedbackResults {
  /** Decision 10: the one attribution gate, read from `visibility`. */
  attributed: boolean;
  askResults: FeedbackAskResult[];
  outstanding: FeedbackOutstanding;
  answeredRecipientCount: number;
  totalRecipientCount: number;
}

// ---------------------------------------------------------------------------
// Ranked consolidation
// ---------------------------------------------------------------------------

/**
 * How big the smaller camp has to be before a split counts as disagreement,
 * as a share of the orderings. One dissenter out of eight is an outlier; two
 * out of eight is a real disagreement.
 */
const CONTESTED_MINORITY_SHARE = 0.25;

function contestedThreshold(orderingCount: number): number {
  return Math.max(1, Math.round(orderingCount * CONTESTED_MINORITY_SHARE));
}

/**
 * Contested means the orderings put an item in two different parts of the
 * list -- not merely that its positions vary.
 *
 * An item is contested when at least `max(1, round(orderings / 4))` people put
 * it in the top third of their ordering *and* at least that many put it in the
 * bottom third. Two orderings are the minimum; one ordering cannot disagree
 * with itself.
 *
 * Why this and not variance: a bare mean hides disagreement, but so does
 * variance, which cannot tell "everyone spread it evenly" from "half the room
 * ranked it first and half ranked it last". The split is the thing the author
 * has to see, so the flag measures the split directly. Thirds rather than
 * "first and last" so it still works on a list of eight, where 2nd and 7th are
 * as much of a disagreement as 1st and 8th. The minority floor is what keeps a
 * lone dissenter in a large pool from painting a consensus item as contested.
 */
export function isRankedItemContested(input: {
  topThirdCount: number;
  bottomThirdCount: number;
  orderingCount: number;
}): boolean {
  if (input.orderingCount < 2) return false;
  const floor = contestedThreshold(input.orderingCount);
  return input.topThirdCount >= floor && input.bottomThirdCount >= floor;
}

interface RankedAccumulator {
  itemId: string;
  title: string;
  positionCounts: number[];
  positionSum: number;
  rankedByCount: number;
  firstPlaceCount: number;
  lastPlaceCount: number;
  topThirdCount: number;
  bottomThirdCount: number;
  order: number;
}

function rankedSummary(entry: RankedAccumulator, orderingCount: number, contested: boolean): string {
  if (entry.rankedByCount === 0) return 'No one ranked this';
  if (contested) {
    return `Contested — ${entry.topThirdCount} of ${orderingCount} put it near the top, `
      + `${entry.bottomThirdCount} near the bottom`;
  }
  const majority = Math.ceil(orderingCount / 2);
  if (entry.firstPlaceCount >= majority) {
    return `Ranked first by ${entry.firstPlaceCount} of ${orderingCount}`;
  }
  if (entry.lastPlaceCount >= majority) {
    return `Ranked last by ${entry.lastPlaceCount} of ${orderingCount}`;
  }
  const mean = entry.positionSum / entry.rankedByCount;
  return `Average position ${mean.toFixed(1)}`;
}

/**
 * Consolidates a set of orderings into one list plus a disagreement read.
 *
 * Removed items are excluded from that responder's opinion rather than pushed
 * to the bottom of it: "I took this off the list" is not the same claim as "I
 * ranked it last", and folding the two would invent last-place votes.
 */
export function consolidateRankedAnswers(
  items: Array<{ id: string; title: string }>,
  orderings: string[][],
): FeedbackRankedResult {
  const positionCount = Math.max(items.length, 1);
  const accumulators = new Map<string, RankedAccumulator>();
  items.forEach((item, order) => {
    accumulators.set(item.id, {
      itemId: item.id,
      title: item.title,
      positionCounts: new Array<number>(positionCount).fill(0),
      positionSum: 0,
      rankedByCount: 0,
      firstPlaceCount: 0,
      lastPlaceCount: 0,
      topThirdCount: 0,
      bottomThirdCount: 0,
      order,
    });
  });

  const usableOrderings = orderings.filter((ordering) => ordering.length >= 2);
  for (const ordering of usableOrderings) {
    const length = ordering.length;
    const thirdSize = Math.ceil(length / 3);
    ordering.forEach((itemId, index) => {
      const entry = accumulators.get(itemId);
      if (!entry) return;
      const position = index + 1;
      entry.rankedByCount += 1;
      entry.positionSum += position;
      if (position <= entry.positionCounts.length) {
        entry.positionCounts[position - 1] += 1;
      }
      if (position === 1) entry.firstPlaceCount += 1;
      if (position === length) entry.lastPlaceCount += 1;
      if (position <= thirdSize) entry.topThirdCount += 1;
      else if (position > length - thirdSize) entry.bottomThirdCount += 1;
    });
  }

  const orderingCount = usableOrderings.length;
  const sorted = [...accumulators.values()].sort((left, right) => {
    // An item nobody ranked has no mean; it sorts last rather than first.
    const leftMean = left.rankedByCount ? left.positionSum / left.rankedByCount : Number.MAX_SAFE_INTEGER;
    const rightMean = right.rankedByCount ? right.positionSum / right.rankedByCount : Number.MAX_SAFE_INTEGER;
    if (leftMean !== rightMean) return leftMean - rightMean;
    if (left.firstPlaceCount !== right.firstPlaceCount) {
      return right.firstPlaceCount - left.firstPlaceCount;
    }
    return left.order - right.order;
  });

  return {
    kind: 'ranked',
    orderingCount,
    positionCount,
    entries: sorted.map((entry, index) => {
      const contested = isRankedItemContested({
        topThirdCount: entry.topThirdCount,
        bottomThirdCount: entry.bottomThirdCount,
        orderingCount,
      });
      return {
        itemId: entry.itemId,
        title: entry.title,
        rank: index + 1,
        positionCounts: entry.positionCounts,
        meanPosition: entry.rankedByCount ? entry.positionSum / entry.rankedByCount : 0,
        firstPlaceCount: entry.firstPlaceCount,
        lastPlaceCount: entry.lastPlaceCount,
        rankedByCount: entry.rankedByCount,
        contested,
        summary: rankedSummary(entry, orderingCount, contested),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Whole-request build
// ---------------------------------------------------------------------------

/** Decision 10's single gate. Nothing else may decide this. */
export function feedbackResultsAreAttributed(
  request: Pick<FeedbackRequestReadModel, 'visibility'>,
): boolean {
  return request.visibility === 'open';
}

function tallyChoice(
  ask: FeedbackAsk,
  responses: FeedbackResponseReadModel[],
  voterFor: (response: FeedbackResponseReadModel) => FeedbackResultsVoter | null,
): FeedbackChoiceResult {
  const options: Array<{ id: string; label: string; description?: string }> =
    ask.type === 'singleSelect'
      ? ask.options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
      }))
      : ask.type === 'multiSelect'
        ? ask.items.map((item) => ({
          id: item.id,
          label: item.title,
          description: item.subtitle,
        }))
        : [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ];

  const counts = new Map<string, { count: number; voters: FeedbackResultsVoter[] }>();
  for (const option of options) counts.set(option.id, { count: 0, voters: [] });
  const otherNotes: FeedbackChoiceResult['otherNotes'] = [];

  for (const response of responses) {
    const voter = voterFor(response);
    const selectedIds = response.answer.type === 'singleSelect'
      ? [response.answer.selectedId]
      : response.answer.type === 'multiSelect'
        ? response.answer.selectedIds
        : response.answer.type === 'confirm'
          ? [response.answer.value ? 'yes' : 'no']
          : [];
    for (const selectedId of selectedIds) {
      const bucket = counts.get(selectedId);
      if (!bucket) continue;
      bucket.count += 1;
      if (voter) bucket.voters.push(voter);
    }
    if (response.answer.type === 'singleSelect' && response.answer.otherText) {
      otherNotes.push({ id: response.id, text: response.answer.otherText, author: voter });
    }
  }

  const answered = responses.length;
  const highest = Math.max(0, ...options.map((option) => counts.get(option.id)?.count ?? 0));
  const leaderCount = options.filter(
    (option) => (counts.get(option.id)?.count ?? 0) === highest,
  ).length;

  const artifacts = 'artifacts' in ask ? ask.artifacts : undefined;
  return {
    kind: 'choice',
    otherNotes,
    options: options
      .map((option) => {
        const bucket = counts.get(option.id) ?? { count: 0, voters: [] };
        const artifact = artifacts?.find((entry) => entry.entryId === option.id);
        return {
          optionId: option.id,
          label: option.label,
          description: option.description,
          count: bucket.count,
          percent: answered > 0 ? Math.round((bucket.count / answered) * 100) : 0,
          isLeader: highest > 0 && leaderCount === 1 && bucket.count === highest,
          voters: bucket.voters,
          ...(artifact ? { artifact } : {}),
        };
      })
      .sort((left, right) => right.count - left.count),
  };
}

function detailForAsk(
  ask: FeedbackAsk,
  responses: FeedbackResponseReadModel[],
  voterFor: (response: FeedbackResponseReadModel) => FeedbackResultsVoter | null,
): FeedbackAskResultDetail {
  if (ask.type === 'reorder') {
    const orderings: string[][] = [];
    for (const response of responses) {
      if (response.answer.type !== 'reorder') continue;
      const removed = new Set(response.answer.removedIds);
      orderings.push(response.answer.orderedIds.filter((id) => !removed.has(id)));
    }
    // Bound artifacts are attached after consolidation rather than threaded
    // through it: the ranking arithmetic has no opinion about what is being
    // ranked, and giving it one would be the wrong seam.
    const consolidated = consolidateRankedAnswers(ask.items, orderings);
    const artifacts = ask.artifacts;
    if (!artifacts?.length) return consolidated;
    return {
      ...consolidated,
      entries: consolidated.entries.map((entry) => {
        const artifact = artifacts.find((bound) => bound.entryId === entry.itemId);
        return artifact ? { ...entry, artifact } : entry;
      }),
    };
  }

  if (ask.type === 'editText') {
    return {
      kind: 'text',
      answers: responses.flatMap((response) => (
        response.answer.type === 'editText'
          ? [{
            id: response.id,
            text: response.answer.text,
            author: voterFor(response),
            answeredAt: response.updatedAt,
          }]
          : []
      )),
    };
  }

  if (ask.type === 'rating') {
    const values = responses.flatMap((response) => (
      response.answer.type === 'rating' ? [response.answer.value] : []
    ));
    return {
      kind: 'rating',
      count: values.length,
      mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
      lowest: values.length ? Math.min(...values) : 0,
      highest: values.length ? Math.max(...values) : 0,
      scaleMin: ask.min,
      scaleMax: ask.max,
    };
  }

  return tallyChoice(ask, responses, voterFor);
}

function outstandingFor(
  request: FeedbackRequestReadModel,
  attributed: boolean,
  progress: FeedbackRequestProgress | undefined,
  askLabelById: Map<string, string>,
  askOrder: Map<string, number>,
): FeedbackOutstanding {
  if (!attributed) {
    const count = progress
      ? Math.max(0, progress.totalRecipientCount - progress.answeredRecipientCount)
      : null;
    return { kind: 'anonymous', count };
  }

  // One pass over responses, then one pass over assignments -- not a lookup
  // per recipient per ask.
  const answeredByRecipient = new Map<string, Set<string>>();
  for (const response of request.responses) {
    const userId = response.recipientUserId;
    if (!userId) continue;
    let answered = answeredByRecipient.get(userId);
    if (!answered) {
      answered = new Set<string>();
      answeredByRecipient.set(userId, answered);
    }
    answered.add(response.askId);
  }

  const pendingByRecipient = new Map<string, string[]>();
  for (const assignment of request.assignments) {
    if (assignment.target.kind !== 'user') continue;
    const userId = assignment.target.userId;
    if (answeredByRecipient.get(userId)?.has(assignment.askId)) continue;
    const label = askLabelById.get(assignment.askId);
    if (label === undefined) continue;
    const pending = pendingByRecipient.get(userId);
    if (pending) pending.push(assignment.askId);
    else pendingByRecipient.set(userId, [assignment.askId]);
  }

  const people: FeedbackOutstandingPerson[] = [];
  for (const recipient of request.recipients) {
    const pendingAskIds = pendingByRecipient.get(recipient.userId);
    if (!pendingAskIds || pendingAskIds.length === 0) continue;
    people.push({
      userId: recipient.userId,
      name: recipient.name,
      initials: initialsFor(recipient.name),
      pendingAskLabels: pendingAskIds
        .sort((left, right) => (askOrder.get(left) ?? 0) - (askOrder.get(right) ?? 0))
        .map((askId) => askLabelById.get(askId) ?? askId),
    });
  }

  return { kind: 'named', count: people.length, people };
}

export function buildFeedbackResults(
  request: FeedbackRequestReadModel,
  progress?: FeedbackRequestProgress,
): FeedbackResults {
  const attributed = feedbackResultsAreAttributed(request);

  const recipientsById = new Map(
    request.recipients.map((recipient) => [recipient.userId, recipient]),
  );
  const voterCache = new Map<string, FeedbackResultsVoter>();
  const voterFor = (response: FeedbackResponseReadModel): FeedbackResultsVoter | null => {
    // The server owns response projection. Do not add a visibility filter here:
    // doing so would hide a server leak from this surface while the response is
    // still present in atoms, persistence, devtools, and other clients.
    const userId = response.recipientUserId;
    if (!userId) return null;
    const cached = voterCache.get(userId);
    if (cached) return cached;
    const name = recipientsById.get(userId)?.name ?? userId;
    const voter: FeedbackResultsVoter = { userId, name, initials: initialsFor(name) };
    voterCache.set(userId, voter);
    return voter;
  };

  const responsesByAsk = new Map<string, FeedbackResponseReadModel[]>();
  for (const response of request.responses) {
    const bucket = responsesByAsk.get(response.askId);
    if (bucket) bucket.push(response);
    else responsesByAsk.set(response.askId, [response]);
  }

  const assignedCounts = new Map<string, number>();
  for (const assignment of request.assignments) {
    assignedCounts.set(assignment.askId, (assignedCounts.get(assignment.askId) ?? 0) + 1);
  }

  const askLabelById = new Map(request.asks.map((ask) => [ask.id, ask.label]));
  const askOrder = new Map(request.asks.map((ask, index) => [ask.id, index]));

  const askResults = request.asks.map((ask, index) => {
    const responses = responsesByAsk.get(ask.id) ?? [];
    return {
      ask,
      index: index + 1,
      answeredCount: responses.length,
      assignedCount: assignedCounts.get(ask.id) ?? 0,
      detail: detailForAsk(ask, responses, voterFor),
    };
  });

  return {
    attributed,
    askResults,
    outstanding: outstandingFor(request, attributed, progress, askLabelById, askOrder),
    answeredRecipientCount: progress?.answeredRecipientCount ?? 0,
    totalRecipientCount: progress?.totalRecipientCount ?? request.recipients.length,
  };
}
