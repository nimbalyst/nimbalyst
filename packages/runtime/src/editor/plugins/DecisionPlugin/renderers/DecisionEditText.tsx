/**
 * `editText`, in both states.
 *
 * The answered state is the reason this type earns its place. There is nothing
 * to average in prose, and a CRDT merge of four independent rewrites of the
 * same paragraph produces text nobody wrote. So the tally is a **list of
 * proposals**: each person's revision is a card, diffed against the seed, with
 * its own backers, and sealing accepts exactly one while the losers stay in the
 * fence. This is the type that most directly answers "someone rewrote the
 * paragraph and we lost the version we agreed on."
 *
 * The control is a plain textarea rather than the transcript's inline Lexical
 * editor. Mounting a nested Lexical instance inside a decorator of the outer
 * Lexical editor is a real hazard -- nested editor contexts, competing key
 * handlers, and a second history stack -- and a decision block is already
 * inside a document editor, so the formatting toolbar it would bring has a host
 * one level up. Worth revisiting, but not worth the mount risk here.
 */

import React from 'react';
import type {
  DecisionEditTextTally,
  DecisionProposalTally,
  FeedbackAnswer,
} from '@nimbalyst/collab-protocol';

import { AvatarStack } from './DecisionPrimitives';
import type { DecisionMember } from '../../../decisions/types';

interface ControlProps {
  seed: string;
  placeholder?: string;
  maxLength?: number;
  draft: FeedbackAnswer | undefined;
  onDraftChange: (answer: FeedbackAnswer) => void;
  disabled: boolean;
}

export const DecisionEditTextControl: React.FC<ControlProps> = ({
  seed,
  placeholder,
  maxLength,
  draft,
  onDraftChange,
  disabled,
}) => {
  const text = draft?.type === 'editText' ? draft.text : seed;
  const edited = text !== seed;

  return (
    <div className="decision-edittext">
      <textarea
        className="decision-edittext-area"
        value={text}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        rows={4}
        data-testid="decision-edittext-input"
        onChange={(event) =>
          onDraftChange({
            type: 'editText',
            text: event.target.value,
            // `edited` is what tells the tally whether this is a real proposal
            // or an endorsement of the draft as written.
            edited: event.target.value !== seed,
          })
        }
      />
      <div className="decision-edittext-foot">
        <span className={edited ? 'decision-edited' : 'decision-quiet'}>
          {edited ? 'edited from draft' : 'unchanged'}
        </span>
        <span className="decision-quiet">{` · ${text.length} chars`}</span>
      </div>
    </div>
  );
};

/**
 * Word-level diff against the seed.
 *
 * Deliberately crude -- a common-prefix/common-suffix trim rather than a real
 * LCS. On the edits this actually sees (a sentence reworded, a clause swapped)
 * it produces the right highlight, and a wrong-but-readable diff on a total
 * rewrite is better than pulling a diff library into the editor bundle for a
 * card that is three lines tall.
 */
function diffWords(seed: string, revision: string): React.ReactNode {
  const before = seed.split(/(\s+)/);
  const after = revision.split(/(\s+)/);

  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const removed = before.slice(head, before.length - tail).join('');
  const added = after.slice(head, after.length - tail).join('');

  return (
    <>
      {after.slice(0, head).join('')}
      {removed ? <del>{removed}</del> : null}
      {removed && added ? ' ' : null}
      {added ? <ins>{added}</ins> : null}
      {after.slice(after.length - tail).join('')}
    </>
  );
}

export const DecisionProposalList: React.FC<{
  seed: string;
  tally: DecisionEditTextTally;
  members: readonly DecisionMember[];
  viewerId: string | undefined;
  /** Absent when the viewer cannot seal; the accept affordance is then hidden. */
  onAccept?: (proposal: DecisionProposalTally) => void;
}> = ({ seed, tally, members, viewerId, onAccept }) => {
  const leaderCount = tally.proposals[0]?.count ?? 0;
  const nameFor = (id: string): string =>
    members.find((member) => member.id === id)?.name ?? id;

  return (
    <div className="decision-proposals">
      {tally.proposals.map((proposal) => {
        const isMine = proposal.voterId === viewerId;
        // Only a clear leader is marked; a tie has no leader to point at.
        const isLeading =
          proposal.count === leaderCount &&
          leaderCount > 0 &&
          tally.proposals.filter((other) => other.count === leaderCount).length === 1;

        return (
          <div
            key={proposal.voterId}
            className={`decision-prop${isMine ? ' decision-prop--mine' : ''}${
              isLeading ? ' decision-prop--leading' : ''
            }`}
            data-testid="decision-proposal"
          >
            <div className="decision-prop-head">
              <AvatarStack voterIds={[proposal.voterId]} members={members} />
              <span className="decision-prop-who">
                {isMine ? 'You' : (proposal.voterName ?? nameFor(proposal.voterId))}
              </span>
              {proposal.backerIds.length > 1 ? (
                <span className="decision-row-tally">
                  <AvatarStack
                    voterIds={proposal.backerIds.filter((id) => id !== proposal.voterId)}
                    members={members}
                  />
                  <span className="decision-row-count">{proposal.count}</span>
                </span>
              ) : null}
              <span className="decision-grow" />
              {isLeading ? <span className="decision-leading">Leading</span> : null}
              {onAccept ? (
                <button
                  type="button"
                  className="decision-linkish"
                  onClick={() => onAccept(proposal)}
                >
                  Accept
                </button>
              ) : null}
            </div>
            <div className="decision-prop-text">
              {proposal.unchanged ? (
                <span className="decision-quiet">Kept the original wording.</span>
              ) : (
                diffWords(seed, proposal.text)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
