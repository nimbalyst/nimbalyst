/**
 * The decorator for a `DecisionNode`.
 *
 * Owns the chrome every ask type shares -- eyebrow, question, footer -- and
 * delegates the control to a per-type renderer. Three renderings per type, not
 * two: the transcript already has "before you answer", and a document adds
 * "after you answer", where the block flips from control to tally. Sealed is
 * the third, and it is identical for all six types: a single quiet row, because
 * a plan document accumulates decisions and a dozen permanently-expanded
 * tallies turn a readable document into a dashboard.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey } from "lexical";
import {
  canViewerSeeDecisionTally,
  checkDecisionSeal,
  decisionOutcomeSummary,
  decisionProgress,
  isValidDecisionAnswer,
  proposeDecisionOutcome,
  tallyDecision,
  type DecisionBlockSource,
  type DecisionProposalTally,
  type DecisionResolvedValue,
  type DecisionVote,
  type FeedbackAnswer,
} from "@nimbalyst/collab-protocol";

import {
  parseDecisionFence,
  reconcileDecisionFence,
  sealDecisionFence,
} from "./decisionFence";
import { $isDecisionNode } from "./DecisionNode";
import { useDecisionVotes, type DecisionVotingState } from "../../decisions";
import { useFrontmatterUtils } from "../../context/FrontmatterContext";
import {
  AnsweredMark,
  AvatarStack,
  DecisionFooter,
  HiddenTallyNote,
} from "./renderers/DecisionPrimitives";
import { DecisionConfirm, DecisionSelect } from "./renderers/DecisionSelect";
import {
  DecisionReorderControl,
  DecisionReorderTeamOrder,
} from "./renderers/DecisionReorder";
import {
  DecisionEditTextControl,
  DecisionProposalList,
} from "./renderers/DecisionEditText";
import { DecisionRating } from "./renderers/DecisionRating";
import "./DecisionComponent.css";

interface DecisionComponentProps {
  className: string;
  content: string;
  nodeKey: string;
}

/** Per-type verb in the eyebrow, so the ask type is legible before the control is. */
function askVerb(source: DecisionBlockSource): string {
  switch (source.type) {
    case "singleSelect":
      return "pick one";
    case "multiSelect":
      return source.maxSelected
        ? `pick up to ${source.maxSelected}`
        : "pick any";
    case "reorder":
      return `rank ${source.entries.length}`;
    case "editText":
      return "edit the draft";
    case "confirm":
      return "yes or no";
    case "rating":
      return `rate ${source.min ?? 1}–${source.max ?? 5}`;
  }
}

/** The verb on the seal button, which reads badly as a single generic label. */
function sealVerb(source: DecisionBlockSource): string {
  switch (source.type) {
    case "reorder":
      return "Seal this order";
    case "rating":
      return "Seal with a conclusion";
    default:
      return "Seal decision";
  }
}

function respondentNoun(source: DecisionBlockSource): string {
  switch (source.type) {
    case "reorder":
      return "ranked";
    case "rating":
      return "rated";
    case "editText":
      return "proposed";
    default:
      return "answered";
  }
}

function seedDraft(source: DecisionBlockSource): FeedbackAnswer | undefined {
  switch (source.type) {
    case "reorder":
      return {
        type: "reorder",
        orderedIds: source.entries.map((entry) => entry.id),
        removedIds: [],
      };
    case "editText":
      return { type: "editText", text: source.seed ?? "", edited: false };
    // Everything else seeds unanswered. A pre-selected radio or a `confirm`
    // seeded to false submits an opinion the reader never formed.
    default:
      return undefined;
  }
}

function answerIsComplete(
  source: DecisionBlockSource,
  draft: FeedbackAnswer | undefined
): boolean {
  return draft !== undefined && isValidDecisionAnswer(source, draft);
}

function outcomeFromAnswer(
  answer: FeedbackAnswer
): DecisionResolvedValue | undefined {
  switch (answer.type) {
    case "singleSelect":
      return answer.otherText?.trim() || answer.selectedId;
    case "multiSelect":
      return answer.selectedIds;
    case "reorder":
      return answer.orderedIds;
    case "editText":
      return answer.text;
    case "confirm":
      return answer.value;
    case "rating":
      return undefined;
  }
}

const DecisionGlyph: React.FC = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden="true"
  >
    <path d="M8 1.5 14.5 8 8 14.5 1.5 8z" />
  </svg>
);

const CheckGlyph: React.FC = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 8.5 6.3 12 13 4.5" />
  </svg>
);

/**
 * A fence that does not parse still renders as a decision rather than
 * disappearing, and shows its body verbatim so the author can fix it.
 */
const BrokenDecision: React.FC<{ content: string }> = ({ content }) => (
  <div className="decision-block decision-block--broken">
    <div className="decision-eyebrow">
      <DecisionGlyph />
      <span>Decision</span>
      <span className="decision-dot">&middot;</span>
      <span className="decision-broken-note">could not be read</span>
    </div>
    <pre className="decision-broken-body">{content}</pre>
  </div>
);

function formatSealedDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const SealedDecision: React.FC<{ source: DecisionBlockSource }> = ({
  source,
}) => {
  const [expanded, setExpanded] = useState(false);
  const sealed = source.sealed;
  if (!sealed) return null;

  const date = sealed.resolvedAt ? formatSealedDate(sealed.resolvedAt) : "";

  return (
    <div className="decision-sealed-wrap" data-testid="decision-sealed">
      <button
        type="button"
        className="decision-sealed"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="decision-sealed-check">
          <CheckGlyph />
        </span>
        <span className="decision-sealed-outcome">
          {decisionOutcomeSummary(source)}
        </span>
        <span className="decision-sealed-meta">
          {sealed.resolvedBy ? (
            <>
              <span className="decision-sep">&middot;</span>
              {`Decided by ${sealed.resolvedBy}`}
            </>
          ) : null}
          {sealed.votes.length > 0 ? (
            <>
              <span className="decision-sep">&middot;</span>
              {`${sealed.votes.length} ${
                sealed.votes.length === 1 ? "vote" : "votes"
              }`}
            </>
          ) : null}
          {date ? (
            <>
              <span className="decision-sep">&middot;</span>
              {date}
            </>
          ) : null}
        </span>
        <span className="decision-grow" />
        <span
          className={
            expanded ? "decision-chev decision-chev--open" : "decision-chev"
          }
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 6.5 8 10.5 12 6.5" />
          </svg>
        </span>
      </button>
      {expanded ? (
        <div className="decision-sealed-detail">
          <div className="decision-sealed-ask">{source.ask}</div>
          {sealed.score !== undefined ? (
            <div className="decision-quiet">{`Mean ${sealed.score}`}</div>
          ) : null}
          <ul className="decision-sealed-votes">
            {sealed.votes.map((vote, index) => (
              <li key={`${vote.voter}-${index}`}>
                <span className="decision-sealed-voter">{vote.voter}</span>
                <span className="decision-sealed-value">{vote.value}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
};

const SealOutcomeEditor: React.FC<{
  source: DecisionBlockSource;
  outcome: DecisionResolvedValue | undefined;
  onChange: (outcome: DecisionResolvedValue | undefined) => void;
}> = ({ source, outcome, onChange }) => {
  switch (source.type) {
    case "singleSelect":
      return (
        <label className="decision-seal-choice">
          Outcome
          <select
            value={typeof outcome === "string" ? outcome : ""}
            onChange={(event) => onChange(event.target.value || undefined)}
            data-testid="decision-seal-outcome"
          >
            <option value="">Choose an outcome</option>
            {source.entries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label ?? entry.title ?? entry.id}
              </option>
            ))}
          </select>
        </label>
      );
    case "multiSelect": {
      const selected = Array.isArray(outcome) ? outcome : [];
      return (
        <fieldset
          className="decision-seal-choices"
          data-testid="decision-seal-outcome"
        >
          <legend>Outcome</legend>
          {source.entries.map((entry) => (
            <label key={entry.id}>
              <input
                type="checkbox"
                checked={selected.includes(entry.id)}
                onChange={() =>
                  onChange(
                    selected.includes(entry.id)
                      ? selected.filter((id) => id !== entry.id)
                      : [...selected, entry.id]
                  )
                }
              />
              {entry.label ?? entry.title ?? entry.id}
            </label>
          ))}
        </fieldset>
      );
    }
    case "reorder": {
      const orderedIds = Array.isArray(outcome)
        ? outcome
        : source.entries.map((entry) => entry.id);
      const removedIds = source.entries
        .map((entry) => entry.id)
        .filter((id) => !orderedIds.includes(id));
      return (
        <div data-testid="decision-seal-outcome">
          <DecisionReorderControl
            source={source}
            draft={{ type: "reorder", orderedIds, removedIds }}
            onDraftChange={(answer) => {
              if (answer.type === "reorder") onChange(answer.orderedIds);
            }}
            disabled={false}
            tally={null}
            members={[]}
            myAnswer={undefined}
          />
        </div>
      );
    }
    case "confirm":
      return (
        <label className="decision-seal-choice">
          Outcome
          <select
            value={typeof outcome === "boolean" ? String(outcome) : ""}
            onChange={(event) =>
              onChange(
                event.target.value === ""
                  ? undefined
                  : event.target.value === "true"
              )
            }
            data-testid="decision-seal-outcome"
          >
            <option value="">Break the tie</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
      );
    case "rating":
    case "editText":
      return null;
  }
};

const DecisionBlock: React.FC<{
  source: DecisionBlockSource;
  nodeKey: string;
  voting: DecisionVotingState;
}> = ({ source, nodeKey, voting }) => {
  const [editor] = useLexicalComposerContext();
  const { $getFrontmatter, $setFrontmatter } = useFrontmatterUtils();
  const [draft, setDraft] = useState<FeedbackAnswer | undefined>(() =>
    seedDraft(source)
  );
  const [localVote, setLocalVote] = useState<DecisionVote | undefined>();
  const [editing, setEditing] = useState(false);
  const [sealing, setSealing] = useState(false);
  const [conclusion, setConclusion] = useState("");
  const [sealOutcome, setSealOutcome] = useState<
    DecisionResolvedValue | undefined
  >();
  const [sealError, setSealError] = useState<string | null>(null);

  const effectiveVotes = localVote ? [localVote] : voting.votes;
  const myAnswer = voting.myVote?.answer ?? localVote?.answer;
  const hasAnswered = myAnswer !== undefined;
  const showControl = !hasAnswered || editing;

  const tallyVisible = canViewerSeeDecisionTally(
    source,
    effectiveVotes,
    voting.viewer?.id
  );
  const tally = useMemo(
    () =>
      tallyVisible
        ? tallyDecision(source, effectiveVotes, voting.viewer?.id)
        : null,
    [effectiveVotes, source, tallyVisible, voting.viewer?.id]
  );
  const progress = decisionProgress(source, effectiveVotes);

  /**
   * Writes the sealed record into the fence.
   *
   * Shared documents first claim one CRDT key; after concurrent offline claims
   * merge, every peer reconciles the winning claim and the converged vote set
   * into markdown. Local documents have no competing writer, so they re-read
   * and seal the node directly in one editor update.
   */
  const performSeal = useCallback(
    (
      outcome: DecisionResolvedValue,
      resolvedFrom?: string,
      voteOverride?: readonly DecisionVote[]
    ) => {
      const resolvedBy = voting.viewer?.name ?? voting.viewer?.id ?? "unknown";
      if (voting.canRecordVotes) {
        voting.claimSeal({
          outcome,
          resolvedBy,
          resolvedAt: new Date().toISOString(),
          ...(resolvedFrom !== undefined ? { resolvedFrom } : {}),
        });
        setSealing(false);
        setSealError(null);
        return;
      }

      let failure: string | null = null;

      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (!$isDecisionNode(node)) {
          failure = "This decision is no longer in the document.";
          return;
        }

        // Re-read inside the local transaction so an already-sealed or replaced
        // node is never overwritten from a stale render.
        const result = sealDecisionFence(node.getContent(), {
          outcome,
          resolvedBy,
          resolvedAt: new Date(),
          votes: voteOverride ?? effectiveVotes,
          ...(resolvedFrom !== undefined ? { resolvedFrom } : {}),
        });

        if (!result.ok) {
          failure =
            result.reason === "alreadySealed"
              ? "Someone else already sealed this decision."
              : result.reason === "conclusionRequired"
              ? "Write what the team is doing about the rating."
              : result.reason === "unparseable"
              ? "This block could not be read, so it was not sealed."
              : "Pick an outcome to seal.";
          return;
        }

        node.setContent(result.content);

        // Mirror onto the document's frontmatter only when the document IS the
        // decision. In a plan document carrying several decisions the
        // frontmatter belongs to the plan, and stamping a block's outcome onto
        // it would claim the plan itself was decided.
        const frontmatter = $getFrontmatter() ?? {};
        if (frontmatter?.trackerStatus?.type === "decision") {
          $setFrontmatter({
            ...frontmatter,
            status: "decided",
            chosen: decisionOutcomeSummary(result.source),
          });
        }
      });

      if (failure) {
        setSealError(failure);
        return;
      }

      setSealing(false);
      setSealError(null);
    },
    [editor, nodeKey, voting, $getFrontmatter, $setFrontmatter, effectiveVotes]
  );

  const proposed = useMemo(
    () => proposeDecisionOutcome(source, effectiveVotes),
    [source, effectiveVotes]
  );

  const beginSealing = (): void => {
    setSealOutcome(
      proposed ??
        (source.type === "singleSelect"
          ? source.entries[0]?.id
          : source.type === "multiSelect"
          ? []
          : source.type === "reorder"
          ? source.entries.map((entry) => entry.id)
          : undefined)
    );
    setSealing(true);
    setSealError(null);
  };

  const submit = (): void => {
    if (!draft || !answerIsComplete(source, draft)) return;
    if (!voting.canRecordVotes) {
      const vote: DecisionVote = {
        voterId: voting.viewer?.id ?? "local",
        voterName: voting.viewer?.name ?? "You",
        answer: draft,
        at: Date.now(),
      };
      setLocalVote(vote);
      setEditing(false);
      const outcome = outcomeFromAnswer(draft);
      if (source.type === "rating") {
        setSealing(true);
        setSealOutcome(undefined);
        return;
      }
      if (outcome !== undefined) {
        performSeal(
          outcome,
          source.type === "editText" ? vote.voterId : undefined,
          [vote]
        );
      }
      return;
    }
    voting.castVote(draft);
    setEditing(false);
  };

  const acceptProposal = (proposal: DecisionProposalTally): void => {
    performSeal(proposal.text, proposal.voterId);
  };

  const onDraftChange = (answer: FeedbackAnswer): void => {
    setDraft(answer);
  };

  const activeAnswer = showControl ? draft : myAnswer;

  const control = (() => {
    switch (source.type) {
      case "singleSelect":
      case "multiSelect":
        return (
          <DecisionSelect
            source={source}
            draft={activeAnswer}
            onDraftChange={onDraftChange}
            disabled={!showControl || !voting.canVote}
            tally={
              tally &&
              (tally.type === "singleSelect" || tally.type === "multiSelect")
                ? tally
                : null
            }
            members={voting.members}
            myAnswer={myAnswer}
            {...(voting.renderArtifact
              ? { renderArtifact: voting.renderArtifact }
              : {})}
          />
        );
      case "confirm":
        return (
          <DecisionConfirm
            draft={activeAnswer}
            onDraftChange={onDraftChange}
            disabled={!showControl || !voting.canVote}
            tally={tally && tally.type === "confirm" ? tally : null}
            members={voting.members}
            myAnswer={myAnswer}
          />
        );
      case "reorder":
        if (!showControl && tally && tally.type === "reorder") {
          return (
            <DecisionReorderTeamOrder
              source={source}
              tally={tally}
              members={voting.members}
              myAnswer={myAnswer}
            />
          );
        }
        return (
          <DecisionReorderControl
            source={source}
            draft={activeAnswer}
            onDraftChange={onDraftChange}
            disabled={!showControl || !voting.canVote}
            tally={tally && tally.type === "reorder" ? tally : null}
            members={voting.members}
            myAnswer={myAnswer}
          />
        );
      case "editText":
        if (!showControl && tally && tally.type === "editText") {
          return (
            <DecisionProposalList
              seed={source.seed ?? ""}
              tally={tally}
              members={voting.members}
              viewerId={voting.viewer?.id}
              {...(voting.canVote ? { onAccept: acceptProposal } : {})}
            />
          );
        }
        return (
          <DecisionEditTextControl
            seed={source.seed ?? ""}
            {...(source.placeholder !== undefined
              ? { placeholder: source.placeholder }
              : {})}
            {...(source.maxLength !== undefined
              ? { maxLength: source.maxLength }
              : {})}
            draft={activeAnswer}
            onDraftChange={onDraftChange}
            disabled={!showControl || !voting.canVote}
          />
        );
      case "rating":
        return (
          <DecisionRating
            source={source}
            draft={activeAnswer}
            onDraftChange={onDraftChange}
            disabled={!showControl || !voting.canVote}
            tally={tally && tally.type === "rating" ? tally : null}
          />
        );
    }
  })();

  const footerLeft = showControl ? (
    tallyVisible ? (
      <span className="decision-foot-progress">
        {progress.asked > 0
          ? `${progress.answered} of ${progress.asked} ${respondentNoun(
              source
            )}`
          : `${progress.answered} ${respondentNoun(source)}`}
      </span>
    ) : (
      <HiddenTallyNote
        count={progress.answered}
        noun={respondentNoun(source)}
      />
    )
  ) : (
    <>
      <AnsweredMark>You answered</AnsweredMark>
      <span className="decision-sep">&middot;</span>
      <span className="decision-foot-progress">
        {progress.asked > 0
          ? `${progress.answered} of ${progress.asked} ${respondentNoun(
              source
            )}`
          : `${progress.answered} ${respondentNoun(source)}`}
      </span>
    </>
  );

  return (
    <div
      className="decision-block"
      data-testid="decision-block"
      data-decision-id={source.id}
    >
      <div className="decision-eyebrow">
        <DecisionGlyph />
        <span>Decision</span>
        <span className="decision-dot">&middot;</span>
        <span className="decision-id">{source.id}</span>
        <span className="decision-dot">&middot;</span>
        <span>{askVerb(source)}</span>
      </div>
      <div className="decision-ask">{source.ask}</div>
      {source.description ? (
        <div className="decision-desc">{source.description}</div>
      ) : null}

      {control}

      {voting.recommendations.length > 0 ? (
        <div
          className="decision-agent-lane"
          data-testid="decision-recommendation"
        >
          {voting.recommendations.map((recommendation) => (
            <div key={recommendation.agentId} className="decision-agent-row">
              <span className="decision-agent-name">
                {recommendation.agentName ?? recommendation.agentId}
              </span>
              <span className="decision-agent-not-counted">
                recommends · not counted
              </span>
              {recommendation.rationale ? (
                <span className="decision-agent-text">
                  {recommendation.rationale}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {sealing ? (
        <div className="decision-seal-bar" data-testid="decision-seal-bar">
          {source.type === "rating" ? (
            <input
              className="decision-conclusion"
              value={conclusion}
              placeholder="What is the team doing about this?"
              onChange={(event) => setConclusion(event.target.value)}
              data-testid="decision-conclusion-input"
            />
          ) : (
            <SealOutcomeEditor
              source={source}
              outcome={sealOutcome}
              onChange={setSealOutcome}
            />
          )}
          <span className="decision-grow" />
          <button
            type="button"
            className="decision-linkish"
            onClick={() => {
              setSealing(false);
              setSealError(null);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="decision-btn decision-btn--primary"
            onClick={() => {
              const outcome =
                source.type === "rating" ? conclusion : sealOutcome;
              if (outcome !== undefined) {
                performSeal(
                  outcome,
                  undefined,
                  localVote ? [localVote] : undefined
                );
              }
            }}
            disabled={
              source.type === "rating"
                ? conclusion.trim() === ""
                : !checkDecisionSeal(source, sealOutcome).ok
            }
            data-testid="decision-seal-confirm"
          >
            Confirm
          </button>
        </div>
      ) : null}

      {sealError ? (
        <div className="decision-seal-error">{sealError}</div>
      ) : null}

      <DecisionFooter left={footerLeft}>
        {showControl ? (
          <button
            type="button"
            className="decision-btn decision-btn--primary"
            onClick={submit}
            disabled={!voting.canVote || !answerIsComplete(source, draft)}
            data-testid="decision-answer"
          >
            {hasAnswered ? "Save" : "Answer"}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="decision-linkish"
              onClick={() => {
                setDraft(myAnswer);
                setEditing(true);
              }}
              data-testid="decision-change"
            >
              Change
            </button>
            {/* editText seals by accepting a specific proposal, so a generic
                seal button there would have no outcome to point at. */}
            {source.type !== "editText" && voting.canVote ? (
              <button
                type="button"
                className="decision-btn decision-btn--primary"
                onClick={beginSealing}
                data-testid="decision-seal"
              >
                {sealVerb(source)}
              </button>
            ) : null}
          </>
        )}
      </DecisionFooter>

      {!voting.canRecordVotes ? (
        <div className="decision-solo-note">
          Not shared — your answer seals straight to the file.
        </div>
      ) : null}

      {tallyVisible && voting.votes.length > 0 && showControl ? (
        <div className="decision-respondents">
          <AvatarStack
            voterIds={voting.votes.map((vote) => vote.voterId)}
            members={voting.members}
          />
        </div>
      ) : null}
    </div>
  );
};

const ParsedDecisionComponent: React.FC<
  DecisionComponentProps & {
    source: DecisionBlockSource;
  }
> = ({ className, content, nodeKey, source }) => {
  const [editor] = useLexicalComposerContext();
  const { $getFrontmatter, $setFrontmatter } = useFrontmatterUtils();
  const voting = useDecisionVotes(source);

  useEffect(() => {
    const claim = voting.sealClaim;
    if (!claim) return;
    const resolvedAt = new Date(claim.resolvedAt);
    if (Number.isNaN(resolvedAt.getTime())) return;

    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isDecisionNode(node)) return;
      const result = reconcileDecisionFence(node.getContent(), {
        outcome: claim.outcome,
        resolvedBy: claim.resolvedBy,
        resolvedAt,
        votes: voting.votes,
        ...(claim.resolvedFrom !== undefined
          ? { resolvedFrom: claim.resolvedFrom }
          : {}),
      });
      if (!result.ok || result.content === node.getContent()) return;
      node.setContent(result.content);

      const frontmatter = $getFrontmatter() ?? {};
      if (frontmatter?.trackerStatus?.type === "decision") {
        $setFrontmatter({
          ...frontmatter,
          status: "decided",
          chosen: decisionOutcomeSummary(result.source),
        });
      }
    });
  }, [
    $getFrontmatter,
    $setFrontmatter,
    editor,
    nodeKey,
    voting.sealClaim,
    voting.votes,
  ]);

  return (
    <div className={className ? `decision-root ${className}` : "decision-root"}>
      {source.sealed ? (
        <SealedDecision source={source} />
      ) : (
        <DecisionBlock source={source} nodeKey={nodeKey} voting={voting} />
      )}
    </div>
  );
};

const DecisionComponent: React.FC<DecisionComponentProps> = (props) => {
  const source = useMemo(
    () => parseDecisionFence(props.content),
    [props.content]
  );
  if (!source || source.unrecognizedType) {
    return <BrokenDecision content={props.content} />;
  }
  return <ParsedDecisionComponent {...props} source={source} />;
};

export default DecisionComponent;
