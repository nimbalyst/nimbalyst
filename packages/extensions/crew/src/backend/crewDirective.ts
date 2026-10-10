/**
 * The member's standing instructions: a generated preamble plus the
 * definition's personality and directive, passed as the chapter session's
 * `directive` when the chapter is created.
 *
 * The host freezes a session's directive at its first turn (it sits at the
 * front of the prompt-cache prefix), so it is built once per chapter and never
 * changes for the chapter's life. Nothing here depends on the clock or on what
 * woke the member: those change every shift and go in the shift's first user
 * message instead (`buildShiftPrompt`). Editing a definition therefore takes
 * effect at the next chapter; `definitionHash` lets the panel say so.
 */

import { createHash } from 'node:crypto';
import type { CrewMemberDefinition } from '../shared/types';

export interface CrewDirectiveInput {
  member: Pick<CrewMemberDefinition, 'slug' | 'name' | 'role' | 'personality' | 'directive' | 'notify'>;
  /** The whole roster at chapter creation; the member itself is filtered out. */
  roster: ReadonlyArray<Pick<CrewMemberDefinition, 'slug' | 'name' | 'role'>>;
}

/** Deterministic for a given input: no clock, no filesystem ordering. */
export function buildCrewDirective(input: CrewDirectiveInput): string {
  const { member } = input;
  const memoryDir = `nimbalyst-local/crew/${member.slug}`;
  const others = input.roster
    .filter((other) => other.slug !== member.slug)
    .slice()
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((other) => `- ${other.name} (${other.role})`);
  const maxLevel = member.notify.maxLevel === 'ask' ? 'page' : member.notify.maxLevel;

  const lines = [
    `## Crew member: ${member.name} (${member.role})`,
    '',
    `You are ${member.name}, a long-running member of this project's crew. You work in shifts: each shift starts with a message that says what time it is and what woke you, and ends when you reply with a short summary of what you did and what is still open. That summary becomes your journal entry.`,
    '',
    '### Your crew',
    others.length > 0 ? others.join('\n') : '- (you are the only member)',
    '',
    '### Memory',
    `- Your notes live at ${memoryDir}/notes.md: standing concerns, open threads, and what you have learned about how the user wants you to work. Keep them current with crew_notes_update; the next chapter starts from them.`,
    `- Your journal lives at ${memoryDir}/journal.md. Add mid-shift entries with crew_journal_append when something is worth remembering before the shift ends.`,
    `- Do not edit files under ${memoryDir}/ or your definition file directly; use the crew tools so concurrent edits by the user are not lost.`,
    '',
    '### Reaching the user',
    `Use crew_flag with a level: note (feed only), flag (desktop notification), or page (desktop and phone). The user caps you at ${maxLevel}, and quiet hours keep flags in the feed. Attach evidence (sessions, files, tracker items) so the user can click through.`,
    'To ask the user a question, use your AskUserQuestion tool with concrete options. It reaches desktop and phone; you may wait for the answer or move on and pick it up next shift.',
    'Nothing outward-facing happens from you: do not push, publish, release, post, or comment on GitHub. Draft it and ask; the user sends it.',
    '',
    '### Your time',
    'crew_schedule_get and crew_schedule_set read and change your schedule within your limits; crew_wake_me sets a one-off wake. Sessions you start report back to you when they settle; you do not need to poll them. crew_roster shows the rest of the crew.',
  ];
  if (member.personality.trim()) {
    lines.push('', '### Personality', member.personality.trim());
  }
  if (member.directive.trim()) {
    lines.push('', '### Your job', member.directive.trim());
  }
  return lines.join('\n');
}

/**
 * Fingerprint of everything a chapter freezes at creation (directive inputs
 * plus provider and model). A different hash for the current definition means
 * the edit is waiting for the next chapter.
 */
export function definitionHash(
  member: Pick<CrewMemberDefinition, 'slug' | 'name' | 'role' | 'personality' | 'directive' | 'notify' | 'provider' | 'model'>,
): string {
  const frozen = {
    name: member.name,
    role: member.role,
    personality: member.personality,
    directive: member.directive,
    maxLevel: member.notify.maxLevel,
    provider: member.provider,
    model: member.model,
  };
  return createHash('sha256').update(JSON.stringify(frozen)).digest('hex').slice(0, 16);
}
