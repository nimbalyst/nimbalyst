/**
 * The list a select or people field picks from: a field chip's popover and a
 * table cell's both draw it, so a choice looks the same wherever it is made.
 */

import React from 'react';
import { MaterialSymbol } from '../../../ui/icons/MaterialSymbol';
import { UserAvatar } from './UserAvatar';
import type { TeamMemberOption } from './TrackerFieldEditor';
import './TrackerFieldPills.css';

export interface TrackerFieldChoice {
  value: string;
  label: string;
  icon?: string;
  color?: string;
  /** Draws the person's avatar in place of an icon. */
  avatarIdentity?: string;
}

/** A `user` field stores the member's email and shows their name. */
export function teamMemberChoices(members: readonly TeamMemberOption[]): TrackerFieldChoice[] {
  return members.map((member) => ({
    value: member.email,
    label: member.name || member.email,
    avatarIdentity: member.name || member.email,
  }));
}

export const TrackerFieldChoiceList: React.FC<{
  choices: readonly TrackerFieldChoice[];
  value: unknown;
  /** Offers "None", which picks `''`. */
  allowNone: boolean;
  onPick: (value: string) => void;
  /** The choice a keyboard is on, when the keys stay in a filter input (`''` is "None"). */
  activeValue?: string;
  testId?: string;
}> = ({ choices, value, allowNone, onPick, activeValue, testId }) => {
  const empty = value === undefined || value === null || value === '';
  const className = (selected: boolean, choiceValue: string) => [
    'tracker-field-choice',
    selected ? 'tracker-field-choice-selected' : '',
    activeValue === choiceValue ? 'tracker-field-choice-active' : '',
  ].filter(Boolean).join(' ');
  // Keep the keyboard's choice in view as it moves through a long list.
  const activeRef = (element: HTMLButtonElement | null) => element?.scrollIntoView?.({ block: 'nearest' });
  return (
    <div className="tracker-field-choice-list" data-testid={testId}>
      {allowNone && (
        <button
          type="button"
          role="option"
          aria-selected={empty}
          className={className(empty, '')}
          ref={activeValue === '' ? activeRef : undefined}
          onClick={() => onPick('')}
        >
          <MaterialSymbol icon="remove" size={15} />
          <span className="tracker-field-choice-label">None</span>
        </button>
      )}
      {choices.map((choice) => {
        const selected = choice.value === value;
        return (
          <button
            key={choice.value}
            type="button"
            role="option"
            aria-selected={selected}
            className={className(selected, choice.value)}
            ref={activeValue === choice.value ? activeRef : undefined}
            onClick={() => onPick(choice.value)}
          >
            {choice.avatarIdentity ? (
              <UserAvatar identity={choice.avatarIdentity} size={16} />
            ) : (
              <MaterialSymbol icon={choice.icon ?? 'circle'} size={15} style={choice.color ? { color: choice.color } : undefined} />
            )}
            <span className="tracker-field-choice-label">{choice.label}</span>
            {selected && <MaterialSymbol icon="check" size={15} />}
          </button>
        );
      })}
    </div>
  );
};
