/**
 * Votes on in-document decisions, stored in the host document's Y.Doc.
 *
 * ## Why the Y.Doc and nothing else
 *
 * The obvious design puts votes on the decision's tracker item, and it is a
 * data-loss bug. A tracker item is a plain JSON row shipped whole: the sync
 * path upserts with `ON CONFLICT (item_id) DO UPDATE SET encrypted_payload =
 * excluded.encrypted_payload`, so the entire payload is replaced with no field
 * diffing and no per-field timestamps. Every mutation is a read-modify-write of
 * the full row, and the outbound payload is snapshotted at enqueue time, so an
 * offline client reconnecting ships a minutes-old payload over everyone's newer
 * state. A `votes: { greg: gutter }` object in `fields` stores fine, passes a
 * single-client test, and silently drops votes under concurrency.
 *
 * ## Why the keyspace is flat
 *
 * The natural shape is a map of blocks whose values are maps of voters. It has
 * a race that only appears with two clients: if nobody has voted on a block
 * yet and two people vote at the same moment, both clients construct a nested
 * `Y.Map` for that block and `set` it. Yjs resolves the conflict by keeping one
 * of the two maps -- and the losing client's vote goes with the map that was
 * discarded. The vote is acknowledged locally, survives a single-client test,
 * and is gone after the merge.
 *
 * So there are no nested containers. One flat `Y.Map` keyed by
 * `blockId \x1f voterId` means every write is a leaf write on a container that
 * always already exists, and last-write-wins applies per voter, which is
 * exactly the semantic a poll wants: two people voting at once both land, and
 * one person changing their mind replaces only their own entry.
 *
 * ## Why not awareness
 *
 * Awareness is coalesced to roughly 2 Hz and is not an event log; intermediate
 * states are never delivered. A vote is durable state, so it is a CRDT write.
 * Awareness is fine for "Karl is looking at this block" and nothing more.
 *
 * ## The solo case
 *
 * There is no repository at all when there is no Y.Doc. A vote container only
 * has to exist when more than one person can write to it, and there is only
 * more than one person when there is a room. Alone on a local file you read the
 * question, pick, and it seals straight to markdown -- no in-flight multi-party
 * state, so nothing to store. Callers must treat an absent doc as "no vote
 * storage", never as a reason to simulate one locally.
 */

import type { Doc, Map as YMap } from "yjs";
import type {
  DecisionRecommendation,
  DecisionResolvedValue,
  DecisionVote,
  FeedbackAnswer,
} from "@nimbalyst/collab-protocol";

/** Top-level container names, siblings of the Lexical root on the same Y.Doc. */
export const DECISION_VOTES_KEY = "decisions";

/**
 * Agent recommendations live in their own container so they cannot be counted
 * by accident. Structural separation rather than a flag on a vote: a design
 * where an agent's input is one boolean away from a human's vote produces a
 * document that lies about who decided.
 */
export const DECISION_RECOMMENDATIONS_KEY = "decisionRecommendations";
export const DECISION_SEALS_KEY = "decisionSeals";

/**
 * Unit separator. Chosen because it cannot occur in a block id (`dcn-` plus
 * hex) or in a member id or email, and because a raw NUL is rejected by this
 * repo's text-file gates and would make any debug dump of the doc unpasteable.
 */
const KEY_SEPARATOR = "\x1f";

export function decisionVoteKey(blockId: string, voterId: string): string {
  return `${blockId}${KEY_SEPARATOR}${voterId}`;
}

function splitKey(key: string): { blockId: string; voterId: string } | null {
  const index = key.indexOf(KEY_SEPARATOR);
  if (index <= 0 || index === key.length - 1) return null;
  return {
    blockId: key.slice(0, index),
    voterId: key.slice(index + 1),
  };
}

export interface DecisionRepositorySnapshot {
  /** Block id -> votes, ordered oldest first. */
  readonly votesByBlock: Readonly<Record<string, readonly DecisionVote[]>>;
  readonly recommendationsByBlock: Readonly<
    Record<string, readonly DecisionRecommendation[]>
  >;
  readonly sealClaimsByBlock: Readonly<Record<string, DecisionSealClaim>>;
}

export interface DecisionSealClaim {
  outcome: DecisionResolvedValue;
  resolvedBy: string;
  resolvedAt: string;
  resolvedFrom?: string;
}

const EMPTY_SNAPSHOT: DecisionRepositorySnapshot = Object.freeze({
  votesByBlock: Object.freeze({}),
  recommendationsByBlock: Object.freeze({}),
  sealClaimsByBlock: Object.freeze({}),
});

export function emptyDecisionSnapshot(): DecisionRepositorySnapshot {
  return EMPTY_SNAPSHOT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAnswer(raw: unknown): FeedbackAnswer | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "singleSelect":
      return typeof raw.selectedId === "string" &&
        (raw.otherText === undefined || typeof raw.otherText === "string")
        ? (raw as unknown as FeedbackAnswer)
        : null;
    case "multiSelect":
      return Array.isArray(raw.selectedIds) &&
        raw.selectedIds.every((id) => typeof id === "string")
        ? (raw as unknown as FeedbackAnswer)
        : null;
    case "reorder":
      return Array.isArray(raw.orderedIds) &&
        raw.orderedIds.every((id) => typeof id === "string") &&
        Array.isArray(raw.removedIds) &&
        raw.removedIds.every((id) => typeof id === "string")
        ? (raw as unknown as FeedbackAnswer)
        : null;
    case "editText":
      return typeof raw.text === "string" && typeof raw.edited === "boolean"
        ? (raw as unknown as FeedbackAnswer)
        : null;
    case "confirm":
      return typeof raw.value === "boolean"
        ? (raw as unknown as FeedbackAnswer)
        : null;
    case "rating":
      return typeof raw.value === "number" && Number.isFinite(raw.value)
        ? (raw as unknown as FeedbackAnswer)
        : null;
    default:
      return null;
  }
}

/** Rejects anything that is not a well-formed stored vote rather than trusting the wire. */
function readVote(voterId: string, raw: unknown): DecisionVote | null {
  if (!isRecord(raw)) return null;
  const answer = readAnswer(raw.answer);
  if (!answer) return null;
  const vote: DecisionVote = {
    voterId,
    answer,
    at: typeof raw.at === "number" ? raw.at : 0,
  };
  if (typeof raw.voterName === "string") vote.voterName = raw.voterName;
  if (typeof raw.note === "string") vote.note = raw.note;
  return vote;
}

function readRecommendation(
  agentId: string,
  raw: unknown
): DecisionRecommendation | null {
  if (!isRecord(raw)) return null;
  const answer = readAnswer(raw.answer);
  if (!answer) return null;
  const recommendation: DecisionRecommendation = {
    agentId,
    answer,
    at: typeof raw.at === "number" ? raw.at : 0,
  };
  if (typeof raw.agentName === "string")
    recommendation.agentName = raw.agentName;
  if (typeof raw.onBehalfOfUserId === "string") {
    recommendation.onBehalfOfUserId = raw.onBehalfOfUserId;
  }
  if (typeof raw.rationale === "string")
    recommendation.rationale = raw.rationale;
  return recommendation;
}

function readSealClaim(raw: unknown): DecisionSealClaim | null {
  if (!isRecord(raw)) return null;
  const outcome = raw.outcome;
  if (
    typeof outcome !== "string" &&
    typeof outcome !== "boolean" &&
    !(
      Array.isArray(outcome) &&
      outcome.every((entry) => typeof entry === "string")
    )
  ) {
    return null;
  }
  if (
    typeof raw.resolvedBy !== "string" ||
    typeof raw.resolvedAt !== "string"
  ) {
    return null;
  }
  return {
    outcome,
    resolvedBy: raw.resolvedBy,
    resolvedAt: raw.resolvedAt,
    ...(typeof raw.resolvedFrom === "string"
      ? { resolvedFrom: raw.resolvedFrom }
      : {}),
  };
}

export class YDocDecisionRepository {
  private readonly doc: Doc;
  private readonly votes: YMap<unknown>;
  private readonly recommendations: YMap<unknown>;
  private readonly seals: YMap<unknown>;
  private readonly listeners = new Set<() => void>();
  private snapshot: DecisionRepositorySnapshot;

  constructor(doc: Doc) {
    this.doc = doc;
    this.votes = doc.getMap<unknown>(DECISION_VOTES_KEY);
    this.recommendations = doc.getMap<unknown>(DECISION_RECOMMENDATIONS_KEY);
    this.seals = doc.getMap<unknown>(DECISION_SEALS_KEY);
    this.snapshot = this.materializeSnapshot();
    this.votes.observe(this.handleChange);
    this.recommendations.observe(this.handleChange);
    this.seals.observe(this.handleChange);
  }

  getSnapshot(): DecisionRepositorySnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    this.votes.unobserve(this.handleChange);
    this.recommendations.unobserve(this.handleChange);
    this.seals.unobserve(this.handleChange);
    this.listeners.clear();
  }

  getVotes(blockId: string): readonly DecisionVote[] {
    return this.snapshot.votesByBlock[blockId] ?? [];
  }

  getRecommendations(blockId: string): readonly DecisionRecommendation[] {
    return this.snapshot.recommendationsByBlock[blockId] ?? [];
  }

  /**
   * Casts or replaces this voter's answer.
   *
   * Replacement is the whole point of keying by voter: changing your mind
   * overwrites your own entry and touches nobody else's. The earlier answer is
   * gone -- deliberately. A live poll wants the current state, and the argument
   * that changed someone's mind belongs in the discussion thread, which keeps
   * its own history.
   */
  castVote(blockId: string, vote: DecisionVote): void {
    const stored: Record<string, unknown> = {
      answer: vote.answer,
      at: vote.at,
    };
    if (vote.voterName !== undefined) stored.voterName = vote.voterName;
    if (vote.note !== undefined) stored.note = vote.note;
    this.doc.transact(() => {
      this.votes.set(decisionVoteKey(blockId, vote.voterId), stored);
    }, this);
  }

  retractVote(blockId: string, voterId: string): void {
    this.doc.transact(() => {
      this.votes.delete(decisionVoteKey(blockId, voterId));
    }, this);
  }

  setRecommendation(
    blockId: string,
    recommendation: DecisionRecommendation
  ): void {
    const stored: Record<string, unknown> = {
      answer: recommendation.answer,
      at: recommendation.at,
    };
    if (recommendation.agentName !== undefined) {
      stored.agentName = recommendation.agentName;
    }
    if (recommendation.onBehalfOfUserId !== undefined) {
      stored.onBehalfOfUserId = recommendation.onBehalfOfUserId;
    }
    if (recommendation.rationale !== undefined) {
      stored.rationale = recommendation.rationale;
    }
    this.doc.transact(() => {
      this.recommendations.set(
        decisionVoteKey(blockId, recommendation.agentId),
        stored
      );
    }, this);
  }

  /**
   * Records this client's seal intent. Concurrent claims share one CRDT key, so
   * Yjs deterministically selects one winner and every peer later reconciles the
   * markdown from that same claim. Votes remain in the Y.Doc as a convergence
   * buffer so a write that was unseen at claim time cannot be deleted or lost.
   */
  claimSeal(blockId: string, claim: DecisionSealClaim): void {
    this.doc.transact(() => {
      if (!this.seals.has(blockId)) this.seals.set(blockId, claim);
    }, this);
  }

  /**
   * Drops all live state for a block.
   *
   * This is an explicit maintenance operation, not part of sealing. Calling it
   * before every peer has acknowledged the seal can resurrect or lose an
   * unseen concurrent vote, so the UI deliberately retains live votes as a
   * convergence buffer after the fence becomes authoritative.
   */
  clearBlock(blockId: string): void {
    const prefix = `${blockId}${KEY_SEPARATOR}`;
    this.doc.transact(() => {
      for (const key of [...this.votes.keys()]) {
        if (key.startsWith(prefix)) this.votes.delete(key);
      }
      for (const key of [...this.recommendations.keys()]) {
        if (key.startsWith(prefix)) this.recommendations.delete(key);
      }
    }, this);
  }

  private readonly handleChange = (): void => {
    this.snapshot = this.materializeSnapshot();
    for (const listener of this.listeners) listener();
  };

  private materializeSnapshot(): DecisionRepositorySnapshot {
    const votesByBlock: Record<string, DecisionVote[]> = {};
    for (const [key, raw] of this.votes.entries()) {
      const parts = splitKey(key);
      if (!parts) continue;
      const vote = readVote(parts.voterId, raw);
      if (!vote) continue;
      (votesByBlock[parts.blockId] ??= []).push(vote);
    }

    const recommendationsByBlock: Record<string, DecisionRecommendation[]> = {};
    for (const [key, raw] of this.recommendations.entries()) {
      const parts = splitKey(key);
      if (!parts) continue;
      const recommendation = readRecommendation(parts.voterId, raw);
      if (!recommendation) continue;
      (recommendationsByBlock[parts.blockId] ??= []).push(recommendation);
    }

    // Stable order regardless of map iteration, so the tally and the avatar
    // stacks do not reshuffle when an unrelated voter arrives.
    const frozenVotes: Record<string, readonly DecisionVote[]> = {};
    for (const [blockId, votes] of Object.entries(votesByBlock)) {
      votes.sort((a, b) => a.at - b.at || a.voterId.localeCompare(b.voterId));
      frozenVotes[blockId] = Object.freeze(votes);
    }
    const frozenRecommendations: Record<
      string,
      readonly DecisionRecommendation[]
    > = {};
    for (const [blockId, entries] of Object.entries(recommendationsByBlock)) {
      entries.sort((a, b) => a.at - b.at || a.agentId.localeCompare(b.agentId));
      frozenRecommendations[blockId] = Object.freeze(entries);
    }

    const sealClaimsByBlock: Record<string, DecisionSealClaim> = {};
    for (const [blockId, raw] of this.seals.entries()) {
      const claim = readSealClaim(raw);
      if (claim) sealClaimsByBlock[blockId] = Object.freeze(claim);
    }

    return Object.freeze({
      votesByBlock: Object.freeze(frozenVotes),
      recommendationsByBlock: Object.freeze(frozenRecommendations),
      sealClaimsByBlock: Object.freeze(sealClaimsByBlock),
    });
  }
}
