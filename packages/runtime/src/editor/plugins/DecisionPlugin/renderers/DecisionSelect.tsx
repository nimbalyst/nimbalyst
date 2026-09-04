/**
 * The three row-shaped ask types: `singleSelect`, `multiSelect`, `confirm`.
 *
 * They share a renderer because they share the only thing that varies between
 * them at this level -- how many rows can be on at once. The tally differs in
 * meaning rather than in shape: for `singleSelect` the shares sum to one and
 * the bar reads as a split, while for `multiSelect` the rows are independent,
 * so an item at 4 of 4 and an item at 1 of 4 are both facts and neither is a
 * ranking.
 */

import React from 'react';
import type {
  DecisionBlockSource,
  DecisionSelectTally,
  FeedbackAnswer,
} from '@nimbalyst/collab-protocol';

import { DecisionRow } from './DecisionPrimitives';
import type { DecisionMember } from '../../../decisions/types';

interface SelectProps {
  source: DecisionBlockSource;
  draft: FeedbackAnswer | undefined;
  onDraftChange: (answer: FeedbackAnswer) => void;
  disabled: boolean;
  tally: DecisionSelectTally | null;
  members: readonly DecisionMember[];
  myAnswer: FeedbackAnswer | undefined;
  renderArtifact?: (entryId: string, artifact: string) => React.ReactNode;
}

function selectedIdsOf(answer: FeedbackAnswer | undefined): string[] {
  if (!answer) return [];
  if (answer.type === 'singleSelect') return [answer.selectedId];
  if (answer.type === 'multiSelect') return answer.selectedIds;
  return [];
}

export const DecisionSelect: React.FC<SelectProps> = ({
  source,
  draft,
  onDraftChange,
  disabled,
  tally,
  members,
  myAnswer,
  renderArtifact,
}) => {
  const selected = new Set(selectedIdsOf(draft));
  const mine = new Set(selectedIdsOf(myAnswer));
  const isMulti = source.type === 'multiSelect';
  const maxSelected = source.maxSelected ?? source.entries.length;

  const toggle = (entryId: string): void => {
    if (!isMulti) {
      onDraftChange({ type: 'singleSelect', selectedId: entryId });
      return;
    }
    const next = new Set(selected);
    if (next.has(entryId)) {
      next.delete(entryId);
    } else {
      // Silently refusing the click past the cap is better than accepting it
      // and failing validation on submit, which would read as a broken button.
      if (next.size >= maxSelected) return;
      next.add(entryId);
    }
    onDraftChange({
      type: 'multiSelect',
      selectedIds: source.entries
        .map((entry) => entry.id)
        .filter((id) => next.has(id)),
    });
  };

  return (
    <div className="decision-rows">
      {source.entries.map((entry) => {
        const entryTally = tally?.entries.find((row) => row.entryId === entry.id);
        return (
          <DecisionRow
            key={entry.id}
            label={entry.label ?? entry.title ?? entry.id}
            description={entry.description ?? entry.subtitle}
            badge={entry.badge}
            indicator={isMulti ? 'check' : 'radio'}
            selected={selected.has(entry.id)}
            isMine={mine.has(entry.id)}
            onSelect={disabled ? undefined : () => toggle(entry.id)}
            disabled={disabled}
            testId="decision-option-row"
            preview={
              entry.artifact && renderArtifact
                ? renderArtifact(entry.id, entry.artifact)
                : undefined
            }
            tally={
              entryTally
                ? {
                    voterIds: entryTally.voterIds,
                    count: entryTally.count,
                    share: entryTally.share,
                    members,
                  }
                : undefined
            }
          />
        );
      })}
    </div>
  );
};

interface ConfirmProps {
  draft: FeedbackAnswer | undefined;
  onDraftChange: (answer: FeedbackAnswer) => void;
  disabled: boolean;
  tally: { yesVoterIds: readonly string[]; noVoterIds: readonly string[] } | null;
  members: readonly DecisionMember[];
  myAnswer: FeedbackAnswer | undefined;
}

/**
 * Yes and no as two always-visible targets, neither preselected.
 *
 * Unanswered is a third state, not a default no. A single toggle labelled with
 * its own current value reads as "the No option" rather than "currently set to
 * No", and untouched fields then submit a silent false. That matters more in a
 * document than in a transcript: a silent false from someone who never opened
 * the file would be indistinguishable from a considered no.
 */
export const DecisionConfirm: React.FC<ConfirmProps> = ({
  draft,
  onDraftChange,
  disabled,
  tally,
  members,
  myAnswer,
}) => {
  const value = draft?.type === 'confirm' ? draft.value : null;
  const mine = myAnswer?.type === 'confirm' ? myAnswer.value : null;
  const total = tally ? tally.yesVoterIds.length + tally.noVoterIds.length : 0;

  const row = (target: boolean, label: string) => {
    const voterIds = tally
      ? target
        ? tally.yesVoterIds
        : tally.noVoterIds
      : undefined;
    return (
      <DecisionRow
        key={label}
        label={label}
        indicator="radio"
        selected={value === target}
        isMine={mine === target}
        onSelect={disabled ? undefined : () => onDraftChange({ type: 'confirm', value: target })}
        disabled={disabled}
        testId="decision-confirm-row"
        tally={
          voterIds
            ? {
                voterIds,
                count: voterIds.length,
                share: total === 0 ? 0 : voterIds.length / total,
                members,
              }
            : undefined
        }
      />
    );
  };

  return (
    <div className="decision-rows" role="radiogroup" data-checked={value === null ? 'unanswered' : value}>
      {row(true, 'Yes')}
      {row(false, 'No')}
    </div>
  );
};
