/**
 * The people and dates groups of the `@` menu. `DocumentLinkPlugin` owns the
 * one `@` typeahead; it merges these options ahead of its page and file
 * options and hands a selected one back to `$insertMentionOption`.
 *
 * People appear once the query matches a member's name or email (an empty `@`
 * stays a page picker). Dates appear for "today", "tomorrow", "next week",
 * "date", or a typed `YYYY-MM-DD`.
 */

import React from 'react';
import { $createTextNode, type LexicalEditor, type RangeSelection } from 'lexical';

import { MaterialSymbol } from '../../../ui/icons/MaterialSymbol';
import { dateShortcuts, formatAbsoluteDate } from './mentionDates';
import { $createMentionNode, MentionNode } from './MentionNodeCore';

export interface MentionMember {
  name: string;
  email: string;
}

const PERSON_PREFIX = 'mention-person:';
const DATE_PREFIX = 'mention-date:';
const MAX_PEOPLE = 5;

export interface MentionOption {
  id: string;
  label: string;
  secondaryText?: string;
  tooltip?: string;
  icon: React.ReactNode;
  keywords: string[];
}

/** True when the editor can hold mention chips (the menu also serves editors that cannot). */
export function editorSupportsMentions(editor: LexicalEditor): boolean {
  return editor.hasNodes([MentionNode]);
}

export function buildMentionOptions(query: string, members: readonly MentionMember[], now: Date = new Date()): MentionOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const icon = (name: string) => <MaterialSymbol style={{ fontSize: 16, verticalAlign: 'middle' }} icon={name} />;
  const people = members
    .filter((member) => member.email && (member.name.toLowerCase().includes(q) || member.email.toLowerCase().includes(q)))
    .slice(0, MAX_PEOPLE)
    .map((member): MentionOption => ({
      id: `${PERSON_PREFIX}${member.email}\n${member.name}`,
      label: member.name || member.email,
      secondaryText: member.email,
      icon: icon('person'),
      keywords: [member.name, member.email],
    }));
  const dates = ('date'.startsWith(q) ? dateShortcuts('', now) : dateShortcuts(q, now)).map((shortcut): MentionOption => ({
    id: `${DATE_PREFIX}${shortcut.iso}`,
    label: shortcut.label,
    secondaryText: shortcut.iso,
    tooltip: formatAbsoluteDate(shortcut.iso),
    icon: icon('calendar_today'),
    keywords: [shortcut.label, shortcut.iso],
  }));
  return [...people, ...dates];
}

/** Insert the chip for a selected mention option. False when the id is not a mention. */
export function $insertMentionOption(selection: RangeSelection, optionId: string): boolean {
  let node: MentionNode;
  if (optionId.startsWith(PERSON_PREFIX)) {
    const [email, name] = optionId.slice(PERSON_PREFIX.length).split('\n');
    node = $createMentionNode('person', email!, name ?? '');
  } else if (optionId.startsWith(DATE_PREFIX)) {
    node = $createMentionNode('date', optionId.slice(DATE_PREFIX.length));
  } else {
    return false;
  }
  selection.insertNodes([node]);
  const space = $createTextNode(' ');
  node.insertAfter(space);
  space.select();
  return true;
}
