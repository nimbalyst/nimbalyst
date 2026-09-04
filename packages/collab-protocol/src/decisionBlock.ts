/**
 * In-document decisions: the model for a `decision` markdown fence, the votes
 * cast against it, and the tally each ask type collapses to.
 *
 * Three properties drive the shape here.
 *
 * **The fence is the record.** A sealed decision has to survive export, git, a
 * reader with no Nimbalyst, and an agent that only reads the file, so the
 * question and the outcome live in the markdown rather than in a database. That
 * makes the parsed fence -- not a row -- the authoritative object, and it means
 * unknown keys must survive a parse/serialize round trip: once a `decision`
 * fence exists in someone's file the syntax is effectively frozen, and a v1
 * parser that drops a key a later version wrote would silently destroy it.
 * `DecisionBlockSource.raw` exists for exactly that.
 *
 * **The ask vocabulary is borrowed, not redefined.** `FeedbackAsk` already
 * spans `singleSelect | multiSelect | reorder | editText | confirm | rating`
 * and is already shared with `PromptForUserInput` through `structuredInput.ts`.
 * A document decision is a third surface over the same six types, so it reuses
 * that union verbatim and converts a fence into a `FeedbackAsk` rather than
 * carrying a parallel vocabulary. Adding a seventh ask type stays a
 * single-file change.
 *
 * **N people answer, not one.** This is the only axis a document adds over the
 * transcript widget, and it is what the tally types below exist for. Note that
 * no tally resolves anything: sealing is a person's action in all six cases,
 * which is why `reorder` and `rating` -- neither of which has a natural winner
 * -- need no special lifecycle.
 *
 * Everything in this module is pure. It has no room, no transport, and no
 * storage; `collab-protocol` carries no runtime dependencies at all, so YAML
 * parsing of the fence body lives in `packages/runtime` and hands the result
 * here as a plain record.
 */

import type {
  FeedbackAnswer,
  FeedbackAsk,
  FeedbackAskType,
  FeedbackRequestVisibility,
} from "./feedbackRequest.js";
import type {
  StructuredInputMultiSelectItem,
  StructuredInputReorderItem,
  StructuredInputSingleSelectOption,
} from "./structuredInput.js";

/** The fence language tag. */
export const DECISION_FENCE_LANGUAGE = "decision";

/** The write-in sentinel, accepted only when the ask sets `allowOther`. */
export const DECISION_OTHER_OPTION_ID = "__other__";

/** Mirrors `MAX_FEEDBACK_TEXT_ANSWER_LENGTH`; held in step by the parity test. */
export const MAX_DECISION_TEXT_ANSWER_LENGTH = 32 * 1024;

/** Prefix for generated block ids, e.g. `dcn-7f3a2c`. */
export const DECISION_ID_PREFIX = "dcn";

export const DECISION_ASK_TYPES = [
  "singleSelect",
  "multiSelect",
  "reorder",
  "editText",
  "confirm",
  "rating",
] as const satisfies readonly FeedbackAskType[];

export function isDecisionAskType(value: unknown): value is FeedbackAskType {
  return (
    typeof value === "string" &&
    (DECISION_ASK_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Ask types whose entries can carry an artifact, so "which of these three
 * mockups" renders three live embeds instead of three strings. Deliberately
 * narrower than the full vocabulary and identical to
 * `FeedbackArtifactBearingAskType`: an embed per checkbox row has no scenario
 * behind it, and widening this later is purely additive.
 */
export const DECISION_ARTIFACT_BEARING_TYPES = [
  "singleSelect",
  "reorder",
] as const;

export function decisionTypeCarriesArtifacts(type: FeedbackAskType): boolean {
  return (DECISION_ARTIFACT_BEARING_TYPES as readonly string[]).includes(type);
}

/**
 * Per-type default for hidden-until-answered.
 *
 * A default rather than a global toggle because the two types where seeing the
 * running count first genuinely changes what people answer are not the two
 * where watching the tally build is the useful part. A `multiSelect` tally
 * anchors which items look "already agreed"; a `rating` mean pulls later raters
 * toward it. For the rest, an open tally is the point.
 */
export function decisionDefaultVisibility(
  type: FeedbackAskType
): FeedbackRequestVisibility {
  return type === "multiSelect" || type === "rating"
    ? "hiddenUntilAnswered"
    : "open";
}

/** An entry in a `singleSelect` or `reorder` fence, before normalization. */
export interface DecisionEntrySource {
  id: string;
  /** Original mapping, retained so future per-entry fields survive write-back. */
  raw?: Record<string, unknown>;
  /** `label` and `title` are accepted interchangeably when hand-authored. */
  label?: string;
  title?: string;
  description?: string;
  subtitle?: string;
  badge?: string;
  removable?: boolean;
  defaultChecked?: boolean;
  /** Workspace-relative path to an artifact rendered inside the entry. */
  artifact?: string;
}

/**
 * A parsed `decision` fence.
 *
 * `raw` is the whole parsed YAML mapping and is the serialization source of
 * truth; the typed fields are a normalized read over it. Writing back merges
 * onto `raw`, so a key this version does not understand is preserved rather
 * than dropped.
 */
export interface DecisionBlockSource {
  id: string;
  /** The question. Becomes `FeedbackAsk.label`. */
  ask: string;
  description?: string;
  type: FeedbackAskType;
  /** Unknown future type. The current client renders it as unsupported but preserves it. */
  unrecognizedType?: string;

  /** `singleSelect` options, or `multiSelect` / `reorder` items. */
  entries: DecisionEntrySource[];

  allowOther?: boolean;
  minSelected?: number;
  maxSelected?: number;
  minItems?: number;

  /** `editText` seed text, placeholder, and bounds. */
  seed?: string;
  format?: "markdown" | "plain";
  placeholder?: string;
  minLength?: number;
  maxLength?: number;

  /** `rating` scale. */
  min?: number;
  max?: number;
  step?: number;
  minLabel?: string;
  maxLabel?: string;

  /** Names or member ids the decision is addressed to. */
  asked: string[];
  visibility: FeedbackRequestVisibility;

  /** Present only once sealed. */
  sealed?: DecisionSealedRecord;

  /**
   * The full parsed mapping, including keys this version does not model.
   * Serialization starts from this so nothing is lost.
   */
  raw: Record<string, unknown>;
}

/**
 * The sealed outcome, as written back into the fence.
 *
 * `resolved` holds whatever the type's answer shape is -- the same shape
 * `FeedbackAnswer` puts on the wire -- so an option id for `singleSelect`, a
 * list for `multiSelect` and `reorder`, a boolean for `confirm`, a block scalar
 * for `editText`, and a written sentence for `rating`.
 *
 * The tally is recorded as authored rather than verified. A markdown file can
 * be hand-edited, so the app cannot honestly claim the numbers are checked; for
 * a shared document the Y.Doc retains the real votes and the fence carries the
 * human-readable account of them.
 */
export interface DecisionSealedRecord {
  resolved: DecisionResolvedValue;
  resolvedAt: string;
  resolvedBy: string;
  /** `editText` only: which proposal was accepted. */
  resolvedFrom?: string;
  /** `reorder` only: entries dropped from the sealed order. */
  removed?: string[];
  /** `rating` only: the mean, recorded beside the written conclusion. */
  score?: number;
  /** `rating` only: value -> count. */
  distribution?: Record<string, number>;
  /** Attributed votes, in the order they are rendered. */
  votes: DecisionSealedVote[];
}

export type DecisionResolvedValue = string | boolean | string[];

export interface DecisionSealedVote {
  voter: string;
  /** Rendered form of the answer, plus any note the voter left. */
  value: string;
}

/** One person's answer, as stored in the host Y.Doc's `decisions` map. */
export interface DecisionVote {
  /** Team member id in a collab document; git email on a local file. */
  voterId: string;
  /** Display name at the time of voting, so a sealed record reads correctly. */
  voterName?: string;
  answer: FeedbackAnswer;
  /** Epoch millis. Last write wins per voter -- a changed answer replaces. */
  at: number;
  /** Optional rationale, surfaced next to the vote and in the sealed record. */
  note?: string;
}

/**
 * An agent's input on a decision.
 *
 * Kept in its own container rather than alongside votes so it cannot be counted
 * by accident. An agent may recommend with rationale; it never votes, never
 * counts toward a tally, and never satisfies quorum. A design where an agent's
 * vote is indistinguishable from a human's produces a document that lies about
 * who decided.
 */
export interface DecisionRecommendation {
  /** The agent's own id. */
  agentId: string;
  agentName?: string;
  /** The human the agent is acting for, so attribution stays honest. */
  onBehalfOfUserId?: string;
  answer: FeedbackAnswer;
  rationale?: string;
  at: number;
}

// ---------------------------------------------------------------------------
// Normalization: fence entry -> the shapes the shared controls already take
// ---------------------------------------------------------------------------

function entryLabel(entry: DecisionEntrySource): string {
  return entry.label ?? entry.title ?? entry.id;
}

export function toSingleSelectOption(
  entry: DecisionEntrySource
): StructuredInputSingleSelectOption {
  return {
    id: entry.id,
    label: entryLabel(entry),
    ...(entry.description !== undefined
      ? { description: entry.description }
      : entry.subtitle !== undefined
      ? { description: entry.subtitle }
      : {}),
  };
}

export function toMultiSelectItem(
  entry: DecisionEntrySource
): StructuredInputMultiSelectItem {
  return {
    id: entry.id,
    title: entryLabel(entry),
    ...(entry.subtitle !== undefined ? { subtitle: entry.subtitle } : {}),
    ...(entry.badge !== undefined ? { badge: entry.badge } : {}),
    ...(entry.defaultChecked !== undefined
      ? { defaultChecked: entry.defaultChecked }
      : {}),
  };
}

export function toReorderItem(
  entry: DecisionEntrySource
): StructuredInputReorderItem {
  return {
    id: entry.id,
    title: entryLabel(entry),
    ...(entry.subtitle !== undefined ? { subtitle: entry.subtitle } : {}),
    ...(entry.removable !== undefined ? { removable: entry.removable } : {}),
  };
}

/**
 * Projects a fence onto the ask type the shared respond controls consume, so
 * the document block renders the same control the transcript does rather than a
 * lookalike.
 *
 * `description` is required on a `FeedbackAsk` but optional in a fence, so an
 * absent one becomes the empty string rather than being invented.
 */
export function decisionAskFromSource(
  source: DecisionBlockSource
): FeedbackAsk {
  const base = {
    id: source.id,
    label: source.ask,
    description: source.description ?? "",
  };

  switch (source.type) {
    case "singleSelect":
      return {
        ...base,
        type: "singleSelect",
        options: source.entries.map(toSingleSelectOption),
        ...(source.allowOther !== undefined
          ? { allowOther: source.allowOther }
          : {}),
      };
    case "multiSelect":
      return {
        ...base,
        type: "multiSelect",
        items: source.entries.map(toMultiSelectItem),
        ...(source.minSelected !== undefined
          ? { minSelected: source.minSelected }
          : {}),
        ...(source.maxSelected !== undefined
          ? { maxSelected: source.maxSelected }
          : {}),
      };
    case "reorder":
      return {
        ...base,
        type: "reorder",
        items: source.entries.map(toReorderItem),
        ...(source.minItems !== undefined ? { minItems: source.minItems } : {}),
      };
    case "editText":
      return {
        ...base,
        type: "editText",
        initialText: source.seed ?? "",
        ...(source.format !== undefined ? { format: source.format } : {}),
        ...(source.placeholder !== undefined
          ? { placeholder: source.placeholder }
          : {}),
        ...(source.minLength !== undefined
          ? { minLength: source.minLength }
          : {}),
        ...(source.maxLength !== undefined
          ? { maxLength: source.maxLength }
          : {}),
      };
    case "confirm":
      // No `defaultValue`. An untouched confirm must stay unanswered: a silent
      // false from someone who never opened the document is indistinguishable
      // from a considered no, which is worse in a document than in a transcript
      // because nobody is watching the moment it is submitted.
      return { ...base, type: "confirm" };
    case "rating":
      return {
        ...base,
        type: "rating",
        min: source.min ?? 1,
        max: source.max ?? 5,
        ...(source.step !== undefined ? { step: source.step } : {}),
        ...(source.minLabel !== undefined ? { minLabel: source.minLabel } : {}),
        ...(source.maxLabel !== undefined ? { maxLabel: source.maxLabel } : {}),
      };
  }
}

/**
 * Whether an answer may be recorded against this block.
 *
 * ## Why this is a second implementation of rules that already exist
 *
 * `feedbackRequest.ts` has a module-private `feedbackAnswerIsValid` with the
 * same rules, and importing it would be the obvious move. It is not free:
 * `feedbackRequest.ts` sits in the web console's eagerly-loaded feedback-ui
 * entry, and **any** new value edge into it stops the bundler inlining it into
 * that one entry and turns it into a shared chunk -- measured at ~420 gzip
 * bytes over feedback-ui's budget, for a module that entry never uses. Both
 * routes were tried (exporting the private function, and going through the
 * public `validateFeedbackResponse`) and both cost the same.
 *
 * So the rules are restated here, and `decisionAnswerParity.test.ts` runs both
 * implementations over a matrix of answers and asserts they agree. That turns
 * the drift this duplication would otherwise invite into a failing test.
 *
 * What is deliberately absent is any check on *who* is answering. A decision is
 * answerable by anyone who can read the document, so there is no recipient list
 * and `asked:` is a delivery list rather than a gate.
 */
export function isValidDecisionAnswer(
  source: DecisionBlockSource,
  answerValue: unknown
): boolean {
  // A sealed block takes no further answers; the fence is the record now.
  if (source.sealed) return false;
  return isValidStoredDecisionAnswer(source, answerValue);
}

/**
 * Validates durable CRDT data against the current fence, including while the
 * fence is sealed. A sealed block rejects new writes, but its already-stored
 * votes still need validation when reconciling an in-flight seal.
 */
export function isValidStoredDecisionAnswer(
  source: DecisionBlockSource,
  answerValue: unknown
): boolean {
  if (!answerValue || typeof answerValue !== "object") return false;
  const answer = answerValue as Record<string, unknown>;
  if (answer.type !== source.type) return false;

  const entryIds = source.entries.map((entry) => entry.id);

  switch (source.type) {
    case "singleSelect": {
      if (typeof answer.selectedId !== "string") return false;
      if (entryIds.includes(answer.selectedId)) {
        return (
          answer.otherText === undefined || typeof answer.otherText === "string"
        );
      }
      return (
        source.allowOther === true &&
        answer.selectedId === DECISION_OTHER_OPTION_ID &&
        typeof answer.otherText === "string" &&
        answer.otherText.trim().length > 0
      );
    }
    case "multiSelect": {
      if (
        !Array.isArray(answer.selectedIds) ||
        !answer.selectedIds.every((id) => typeof id === "string")
      )
        return false;
      const selected = answer.selectedIds as string[];
      const allowed = new Set(entryIds);
      return (
        new Set(selected).size === selected.length &&
        selected.every((id) => allowed.has(id)) &&
        selected.length >= (source.minSelected ?? 0) &&
        selected.length <= (source.maxSelected ?? entryIds.length)
      );
    }
    case "reorder": {
      if (
        !Array.isArray(answer.orderedIds) ||
        !Array.isArray(answer.removedIds) ||
        !answer.orderedIds.every((id) => typeof id === "string") ||
        !answer.removedIds.every((id) => typeof id === "string")
      )
        return false;
      const ordered = answer.orderedIds as string[];
      const removed = answer.removedIds as string[];
      const catalog = new Map(source.entries.map((entry) => [entry.id, entry]));
      const all = [...ordered, ...removed];
      return (
        new Set(all).size === all.length &&
        all.length === catalog.size &&
        all.every((id) => catalog.has(id)) &&
        removed.every((id) => catalog.get(id)?.removable === true) &&
        ordered.length >= Math.max(source.minItems ?? 0, 1)
      );
    }
    case "editText": {
      if (
        typeof answer.text !== "string" ||
        typeof answer.edited !== "boolean"
      ) {
        return false;
      }
      const length = answer.text.trim().length;
      return (
        length >= (source.minLength ?? 0) &&
        length <=
          Math.min(
            source.maxLength ?? MAX_DECISION_TEXT_ANSWER_LENGTH,
            MAX_DECISION_TEXT_ANSWER_LENGTH
          )
      );
    }
    case "confirm":
      return typeof answer.value === "boolean";
    case "rating": {
      if (typeof answer.value !== "number" || !Number.isFinite(answer.value)) {
        return false;
      }
      const answerValue = answer.value;
      return decisionRatingScaleValue(source, answerValue) !== undefined;
    }
  }
}

/** Hard ceiling for a hand-authored scale so rendering and tallying stay bounded. */
export const MAX_DECISION_RATING_STEPS = 100;

/**
 * Returns the exact values rendered for a rating, or an empty list for an
 * invalid/unsafe scale. Index-based construction avoids a floating-point loop
 * that can stop advancing when `step` is smaller than the ULP at `min`.
 */
export function decisionRatingScaleValues(
  source: DecisionBlockSource
): number[] {
  const min = source.min ?? 1;
  const max = source.max ?? 5;
  const step = source.step ?? 1;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step))
    return [];
  if (max < min || step <= 0 || min + step === min) return [];
  const stepCount = Math.floor((max - min) / step + Number.EPSILON * 8);
  if (
    !Number.isSafeInteger(stepCount) ||
    stepCount < 0 ||
    stepCount >= MAX_DECISION_RATING_STEPS
  ) {
    return [];
  }
  return Array.from(
    { length: stepCount + 1 },
    (_, index) => Number((min + index * step).toPrecision(15))
  );
}

/** Maps an equivalent decimal (for example `0.3`) onto the rendered step. */
function decisionRatingScaleValue(
  source: DecisionBlockSource,
  candidate: number
): number | undefined {
  return decisionRatingScaleValues(source).find(
    (value) =>
      Math.abs(value - candidate) <=
      Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(candidate)) * 8
  );
}

/** Workspace-relative artifact paths, keyed by entry id. */
export function decisionArtifactsBySource(
  source: DecisionBlockSource
): Record<string, string> {
  if (!decisionTypeCarriesArtifacts(source.type)) return {};
  const out: Record<string, string> = {};
  for (const entry of source.entries) {
    if (entry.artifact) out[entry.id] = entry.artifact;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tallies
// ---------------------------------------------------------------------------

export interface DecisionOptionTally {
  entryId: string;
  /** Voter ids that picked this entry, in vote order. */
  voterIds: string[];
  count: number;
  /** Count over the number of people who answered, 0 when nobody has. */
  share: number;
}

export interface DecisionSelectTally {
  type: "singleSelect" | "multiSelect";
  entries: DecisionOptionTally[];
  respondentCount: number;
}

export interface DecisionReorderEntryTally {
  entryId: string;
  /**
   * Mean 1-based position across submitted rankings. The only aggregation that
   * degrades correctly when someone has not answered -- it simply averages
   * fewer numbers -- which is why it is preferred over drawing N rankings.
   */
  meanPosition: number;
  /** Rank in the team order, 1-based. */
  teamRank: number;
  firstPlaceCount: number;
  /** Voter ids that ranked this entry first. */
  firstPlaceVoterIds: string[];
  /** Entry's position in the viewer's own ranking, when they have answered. */
  viewerPosition?: number;
  /** Voters that dropped this entry entirely. */
  removedByVoterIds: string[];
}

export interface DecisionReorderTally {
  type: "reorder";
  /** Ordered by mean position, best first. */
  entries: DecisionReorderEntryTally[];
  respondentCount: number;
}

export interface DecisionProposalTally {
  voterId: string;
  voterName?: string;
  text: string;
  /** Voters backing this exact text, the author included. */
  backerIds: string[];
  count: number;
  /** True when the text is unchanged from the fence's seed. */
  unchanged: boolean;
}

export interface DecisionEditTextTally {
  type: "editText";
  /** Ordered by backer count, then by submission time. */
  proposals: DecisionProposalTally[];
  respondentCount: number;
}

export interface DecisionConfirmTally {
  type: "confirm";
  yesVoterIds: string[];
  noVoterIds: string[];
  respondentCount: number;
}

export interface DecisionRatingTally {
  type: "rating";
  /** Scale value -> voter ids, covering every step even where empty. */
  distribution: { value: number; voterIds: string[]; count: number }[];
  mean: number;
  respondentCount: number;
  viewerValue?: number;
}

export type DecisionTally =
  | DecisionSelectTally
  | DecisionReorderTally
  | DecisionEditTextTally
  | DecisionConfirmTally
  | DecisionRatingTally;

function sortedVotes(votes: readonly DecisionVote[]): DecisionVote[] {
  return [...votes].sort((a, b) => a.at - b.at);
}

/**
 * Collapses the votes on a block into the shape its answered state renders.
 *
 * `viewerId` is used only to mark the viewer's own answer; it never changes an
 * aggregate. Callers that must honor hidden-until-answered filter the votes
 * before calling rather than passing a flag, so there is one place where "can
 * this person see the tally" is decided.
 */
export function tallyDecision(
  source: DecisionBlockSource,
  votes: readonly DecisionVote[],
  viewerId?: string
): DecisionTally {
  const ordered = sortedVotes(
    votes.filter((vote) => isValidStoredDecisionAnswer(source, vote.answer))
  );
  const respondentCount = ordered.length;

  switch (source.type) {
    case "singleSelect":
    case "multiSelect": {
      const byEntry = new Map<string, string[]>();
      for (const entry of source.entries) byEntry.set(entry.id, []);
      for (const vote of ordered) {
        const picked =
          vote.answer.type === "singleSelect"
            ? [vote.answer.selectedId]
            : vote.answer.type === "multiSelect"
            ? vote.answer.selectedIds
            : [];
        for (const entryId of picked) {
          // An `allowOther` write-in has no entry row; it is surfaced beside the
          // tally rather than silently dropped into a bucket that does not exist.
          const bucket = byEntry.get(entryId);
          if (bucket) bucket.push(vote.voterId);
        }
      }
      return {
        type: source.type,
        respondentCount,
        entries: source.entries.map((entry) => {
          const voterIds = byEntry.get(entry.id) ?? [];
          return {
            entryId: entry.id,
            voterIds,
            count: voterIds.length,
            share:
              respondentCount === 0 ? 0 : voterIds.length / respondentCount,
          };
        }),
      };
    }

    case "reorder": {
      const positions = new Map<string, number[]>();
      const firstPlace = new Map<string, string[]>();
      const removedBy = new Map<string, string[]>();
      for (const entry of source.entries) {
        positions.set(entry.id, []);
        firstPlace.set(entry.id, []);
        removedBy.set(entry.id, []);
      }

      let viewerOrder: string[] | undefined;
      for (const vote of ordered) {
        if (vote.answer.type !== "reorder") continue;
        if (vote.voterId === viewerId) viewerOrder = vote.answer.orderedIds;
        vote.answer.orderedIds.forEach((entryId, index) => {
          positions.get(entryId)?.push(index + 1);
          if (index === 0) firstPlace.get(entryId)?.push(vote.voterId);
        });
        for (const entryId of vote.answer.removedIds) {
          removedBy.get(entryId)?.push(vote.voterId);
        }
      }

      const entries = source.entries.map((entry) => {
        const ranks = positions.get(entry.id) ?? [];
        // An entry nobody ranked sorts last rather than first, which is what an
        // empty mean would otherwise do.
        const meanPosition =
          ranks.length === 0
            ? source.entries.length + 1
            : ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length;
        const firstPlaceVoterIds = firstPlace.get(entry.id) ?? [];
        const viewerIndex = viewerOrder?.indexOf(entry.id) ?? -1;
        return {
          entryId: entry.id,
          meanPosition,
          teamRank: 0,
          firstPlaceCount: firstPlaceVoterIds.length,
          firstPlaceVoterIds,
          ...(viewerIndex >= 0 ? { viewerPosition: viewerIndex + 1 } : {}),
          removedByVoterIds: removedBy.get(entry.id) ?? [],
        };
      });

      // Ties keep the author's declared order, so an unanswered block and a
      // fully-tied one render identically instead of shuffling.
      const authorIndex = new Map(
        source.entries.map((entry, index) => [entry.id, index])
      );
      entries.sort(
        (a, b) =>
          a.meanPosition - b.meanPosition ||
          (authorIndex.get(a.entryId) ?? 0) - (authorIndex.get(b.entryId) ?? 0)
      );
      entries.forEach((entry, index) => {
        entry.teamRank = index + 1;
      });

      return { type: "reorder", entries, respondentCount };
    }

    case "editText": {
      // Prose does not average, and a CRDT merge of four independent rewrites
      // of the same paragraph produces text nobody wrote. So identical text is
      // the only thing that merges: two people who submitted the same wording
      // back one proposal, and everything else stays a discrete alternative
      // that sealing chooses exactly one of.
      const seed = source.seed ?? "";
      const byText = new Map<string, DecisionProposalTally>();
      for (const vote of ordered) {
        if (vote.answer.type !== "editText") continue;
        const text = vote.answer.text;
        const existing = byText.get(text);
        if (existing) {
          existing.backerIds.push(vote.voterId);
          existing.count = existing.backerIds.length;
          continue;
        }
        byText.set(text, {
          voterId: vote.voterId,
          ...(vote.voterName !== undefined
            ? { voterName: vote.voterName }
            : {}),
          text,
          backerIds: [vote.voterId],
          count: 1,
          unchanged: text === seed,
        });
      }
      const proposals = [...byText.values()].sort((a, b) => b.count - a.count);
      return { type: "editText", proposals, respondentCount };
    }

    case "confirm": {
      const yesVoterIds: string[] = [];
      const noVoterIds: string[] = [];
      for (const vote of ordered) {
        if (vote.answer.type !== "confirm") continue;
        (vote.answer.value ? yesVoterIds : noVoterIds).push(vote.voterId);
      }
      return { type: "confirm", yesVoterIds, noVoterIds, respondentCount };
    }

    case "rating": {
      const buckets = new Map<number, string[]>();
      for (const value of decisionRatingScaleValues(source))
        buckets.set(value, []);

      let sum = 0;
      let count = 0;
      let viewerValue: number | undefined;
      for (const vote of ordered) {
        if (vote.answer.type !== "rating") continue;
        const bucketValue = decisionRatingScaleValue(source, vote.answer.value);
        if (bucketValue === undefined) continue;
        buckets.get(bucketValue)?.push(vote.voterId);
        sum += bucketValue;
        count += 1;
        if (vote.voterId === viewerId) viewerValue = bucketValue;
      }

      return {
        type: "rating",
        distribution: [...buckets.entries()].map(([value, voterIds]) => ({
          value,
          voterIds,
          count: voterIds.length,
        })),
        mean: count === 0 ? 0 : sum / count,
        respondentCount,
        ...(viewerValue !== undefined ? { viewerValue } : {}),
      };
    }
  }
}

/**
 * Whether the viewer may see the tally yet.
 *
 * Mirrors `getFeedbackResponsesForViewer`, applied to a Y.Map of votes instead
 * of a room's response list. The author is exempt: they need the tally to seal,
 * and they already know what they asked.
 */
export function canViewerSeeDecisionTally(
  source: DecisionBlockSource,
  votes: readonly DecisionVote[],
  viewerId: string | undefined,
  options?: { isAuthor?: boolean }
): boolean {
  if (source.visibility === "open") return true;
  if (options?.isAuthor) return true;
  if (!viewerId) return false;
  return votes.some((vote) => vote.voterId === viewerId);
}

export interface DecisionProgress {
  answered: number;
  /** People named in `asked:`; 0 means the block is open to any reader. */
  asked: number;
  /** True once everyone named has answered. Informs the seal; never performs it. */
  complete: boolean;
}

export function decisionProgress(
  source: DecisionBlockSource,
  votes: readonly DecisionVote[]
): DecisionProgress {
  const answered = new Set(
    votes
      .filter((vote) => isValidStoredDecisionAnswer(source, vote.answer))
      .map((vote) => vote.voterId)
  );
  const asked = source.asked;
  if (asked.length === 0) {
    return { answered: answered.size, asked: 0, complete: false };
  }
  const answeredAsked = asked.filter((who) => answered.has(who)).length;
  return {
    answered: answered.size,
    asked: asked.length,
    complete: answeredAsked >= asked.length,
  };
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

export type DecisionSealBlockedReason =
  | "alreadySealed"
  | "noOutcome"
  | "conclusionRequired";

export interface DecisionSealCheck {
  ok: boolean;
  reason?: DecisionSealBlockedReason;
}

/**
 * Guards the seal transaction.
 *
 * Deliberately does not check quorum, a majority, or a mean: the seal is a
 * person's action for every type, and the tally only informs it. The one type
 * with an extra requirement is `rating`, where the outcome is the sentence
 * about what the team is doing rather than the average -- sealing a rating with
 * only its mean produces a record that looks settled and decides nothing.
 */
export function checkDecisionSeal(
  source: DecisionBlockSource,
  outcome: DecisionResolvedValue | undefined
): DecisionSealCheck {
  if (source.sealed) return { ok: false, reason: "alreadySealed" };
  if (outcome === undefined) return { ok: false, reason: "noOutcome" };
  const entryIds = new Set(source.entries.map((entry) => entry.id));
  switch (source.type) {
    case "singleSelect":
      if (
        typeof outcome !== "string" ||
        outcome.trim().length === 0 ||
        (!entryIds.has(outcome) && source.allowOther !== true)
      ) {
        return { ok: false, reason: "noOutcome" };
      }
      break;
    case "multiSelect":
      if (
        !Array.isArray(outcome) ||
        outcome.length === 0 ||
        new Set(outcome).size !== outcome.length ||
        outcome.some((id) => !entryIds.has(id))
      ) {
        return { ok: false, reason: "noOutcome" };
      }
      break;
    case "reorder": {
      if (!Array.isArray(outcome) || outcome.length === 0) {
        return { ok: false, reason: "noOutcome" };
      }
      const kept = new Set(outcome);
      if (
        kept.size !== outcome.length ||
        outcome.some((id) => !entryIds.has(id)) ||
        source.entries.some(
          (entry) => !kept.has(entry.id) && entry.removable !== true
        )
      ) {
        return { ok: false, reason: "noOutcome" };
      }
      break;
    }
    case "confirm":
      if (typeof outcome !== "boolean") {
        return { ok: false, reason: "noOutcome" };
      }
      break;
    case "editText":
      if (typeof outcome !== "string" || outcome.trim().length === 0) {
        return { ok: false, reason: "noOutcome" };
      }
      break;
    case "rating":
      if (typeof outcome !== "string" || outcome.trim().length === 0) {
        return { ok: false, reason: "conclusionRequired" };
      }
      break;
  }
  return { ok: true };
}

/**
 * What a seal would record, given the votes so far.
 *
 * A **proposal**, not a resolution. The seal is a person's action for every ask
 * type -- nothing here auto-resolves on quorum, a majority, or a mean -- so
 * this exists to save the sealer retyping the obvious answer, and every value
 * it returns is meant to be shown and overridable before it is committed.
 *
 * Returns `undefined` where there is no defensible default: a tied `confirm`,
 * an unrated scale, and `rating` always (its outcome is a sentence about what
 * the team is doing, which no aggregation can produce).
 */
export function proposeDecisionOutcome(
  source: DecisionBlockSource,
  votes: readonly DecisionVote[]
): DecisionResolvedValue | undefined {
  if (votes.length === 0) return undefined;
  const tally = tallyDecision(source, votes);

  switch (tally.type) {
    case "singleSelect": {
      const best = tally.entries.reduce<DecisionOptionTally | undefined>(
        // Ties keep the author's declared order rather than picking arbitrarily.
        (winner, entry) =>
          !winner || entry.count > winner.count ? entry : winner,
        undefined
      );
      return best && best.count > 0 ? best.entryId : undefined;
    }
    case "multiSelect": {
      // Everything a majority of respondents picked, in the author's order.
      // Rows are independent here, so this is a threshold and not a ranking.
      const threshold = tally.respondentCount / 2;
      const chosen = tally.entries
        .filter((entry) => entry.count > threshold)
        .map((entry) => entry.entryId);
      return chosen.length > 0 ? chosen : undefined;
    }
    case "reorder": {
      const ordered = tally.entries
        .filter(
          (entry) => entry.removedByVoterIds.length < tally.respondentCount
        )
        .map((entry) => entry.entryId);
      return ordered.length > 0 ? ordered : undefined;
    }
    case "confirm": {
      const yes = tally.yesVoterIds.length;
      const no = tally.noVoterIds.length;
      // A tie renders as a tie. Breaking it here would be the tally deciding.
      return yes === no ? undefined : yes > no;
    }
    case "editText":
      return tally.proposals[0]?.text;
    case "rating":
      return undefined;
  }
}

/** Renders one vote for the sealed record's `votes:` list. */
export function renderDecisionVote(
  source: DecisionBlockSource,
  vote: DecisionVote
): DecisionSealedVote {
  const labelFor = (entryId: string): string => {
    const entry = source.entries.find((candidate) => candidate.id === entryId);
    return entry ? entry.label ?? entry.title ?? entry.id : entryId;
  };

  let value: string;
  switch (vote.answer.type) {
    case "singleSelect":
      value = vote.answer.otherText
        ? `other ("${vote.answer.otherText}")`
        : vote.answer.selectedId;
      break;
    case "multiSelect":
      value = vote.answer.selectedIds.join(", ");
      break;
    case "reorder":
      value = vote.answer.orderedIds.map(labelFor).join(" > ");
      break;
    case "editText":
      value = vote.answer.text;
      break;
    case "confirm":
      value = vote.answer.value ? "yes" : "no";
      break;
    case "rating":
      value = String(vote.answer.value);
      break;
  }

  return {
    voter: vote.voterName ?? vote.voterId,
    value: vote.note ? `${value} ("${vote.note}")` : value,
  };
}

/**
 * Builds the record written back into the fence.
 *
 * Callers must have passed `checkDecisionSeal` first; this does not re-guard,
 * because the concurrent-seal check belongs in the transaction that writes the
 * markdown rather than in a pure function that cannot see other clients.
 */
export function buildDecisionSealedRecord(input: {
  source: DecisionBlockSource;
  outcome: DecisionResolvedValue;
  resolvedBy: string;
  resolvedAt: Date;
  votes: readonly DecisionVote[];
  /** `editText` only: the voter whose proposal was accepted. */
  resolvedFrom?: string;
}): DecisionSealedRecord {
  const { source, outcome, resolvedBy, resolvedAt, votes } = input;
  const record: DecisionSealedRecord = {
    resolved: outcome,
    resolvedAt: resolvedAt.toISOString(),
    resolvedBy,
    votes: sortedVotes(
      votes.filter((vote) => isValidStoredDecisionAnswer(source, vote.answer))
    ).map((vote) => renderDecisionVote(source, vote)),
  };

  if (input.resolvedFrom !== undefined)
    record.resolvedFrom = input.resolvedFrom;

  if (source.type === "reorder") {
    const kept = new Set(Array.isArray(outcome) ? outcome : []);
    const dropped = source.entries
      .filter((entry) => entry.removable === true && !kept.has(entry.id))
      .map((entry) => entry.id);
    if (dropped.length > 0) record.removed = dropped;
  }

  if (source.type === "rating") {
    const tally = tallyDecision(source, votes);
    if (tally.type === "rating") {
      record.score = Math.round(tally.mean * 100) / 100;
      const distribution: Record<string, number> = {};
      for (const bucket of tally.distribution) {
        if (bucket.count > 0) distribution[String(bucket.value)] = bucket.count;
      }
      record.distribution = distribution;
    }
  }

  return record;
}

/**
 * The one-line outcome shown on a sealed block, before the chevron is expanded.
 *
 * Every type collapses to the same quiet row so a document full of settled
 * decisions still reads as prose; only this slot differs.
 */
export function decisionOutcomeSummary(source: DecisionBlockSource): string {
  const sealed = source.sealed;
  if (!sealed) return "";
  const labelFor = (entryId: string): string => {
    const entry = source.entries.find((candidate) => candidate.id === entryId);
    return entry ? entry.label ?? entry.title ?? entry.id : entryId;
  };

  const { resolved } = sealed;
  switch (source.type) {
    case "singleSelect":
      return typeof resolved === "string"
        ? labelFor(resolved)
        : String(resolved);
    case "multiSelect":
      return Array.isArray(resolved) ? resolved.map(labelFor).join(", ") : "";
    case "reorder":
      return Array.isArray(resolved) ? resolved.map(labelFor).join(" → ") : "";
    case "confirm":
      return resolved === true ? "Yes" : "No";
    case "editText":
    case "rating":
      return typeof resolved === "string" ? resolved : String(resolved);
  }
}
