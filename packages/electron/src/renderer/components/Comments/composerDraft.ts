/**
 * Composer draft derivation.
 *
 * The textarea's text is the single source of truth for what the message says.
 * The mention and reference lists are DERIVED from it on every keystroke rather
 * than tracked alongside it, because the alternative -- maintaining parallel
 * arrays and hoping edits keep them in sync -- produces the two failure modes
 * that matter: a mention that notifies someone whose name the author deleted,
 * and a `resourceRefs` entry that authorizes a pill nobody can see.
 *
 * A "pool" holds the full ref for every token the author has inserted this
 * session. Deriving intersects the pool with the tokens actually present, so
 * deleting the text deletes the mention, and retyping is not required.
 */

import type { DraftState } from './commentViewModel';
import type { AgentHandle, BodyEntity, PersonHandle, ResourceRef, RichCommentBody } from './commentTypes';
import { agentMentionUrn, mentionUrn, resourceRefToUrn } from './resourceUrn';

/** Every `nimbalyst://` token in the text, labeled or bare. */
const URN_IN_TEXT = /\[[^\]\n]{0,160}\]\((nimbalyst:\/\/[^\s)]{1,512})\)|(nimbalyst:\/\/[A-Za-z0-9._~%!$&'*+,;=:@\-/]{1,512})/g;

export interface DraftPool {
  /** Resource refs keyed by URN. */
  refs: Record<string, ResourceRef>;
  /** Person mentions keyed by URN. */
  people: Record<string, PersonHandle>;
  /** Agent mentions keyed by URN. */
  agents: Record<string, AgentHandle>;
}

export const EMPTY_POOL: DraftPool = { refs: {}, people: {}, agents: {} };

interface UrnOccurrence {
  urn: string;
  start: number;
  end: number;
}

function urnOccurrences(text: string): UrnOccurrence[] {
  const found: UrnOccurrence[] = [];
  URN_IN_TEXT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URN_IN_TEXT.exec(text)) !== null) {
    const urn = match[1] ?? match[2];
    if (urn) {
      found.push({
        urn,
        start: utf8ByteLength(text.slice(0, match.index)),
        end: utf8ByteLength(text.slice(0, match.index + match[0].length)),
      });
    }
  }
  return found;
}

export function urnsInText(text: string): string[] {
  const found: string[] = [];
  for (const occurrence of urnOccurrences(text)) {
    if (!found.includes(occurrence.urn)) found.push(occurrence.urn);
  }
  return found;
}

export function deriveDraft(text: string, format: RichCommentBody['format'], pool: DraftPool): DraftState {
  const occurrences = urnOccurrences(text);
  const resourceRefs: ResourceRef[] = [];
  const mentionedUserIds: string[] = [];
  const mentionedAgentSessionIds: string[] = [];

  for (const { urn } of occurrences) {
    const person = pool.people[urn];
    if (person) {
      if (!mentionedUserIds.includes(person.userId)) mentionedUserIds.push(person.userId);
      continue;
    }
    const agent = pool.agents[urn];
    if (agent) {
      if (!mentionedAgentSessionIds.includes(agent.sessionId)) mentionedAgentSessionIds.push(agent.sessionId);
      // An agent mention is also a session reference, so the reader gets a
      // resolvable pill and the server sees one authorizable ref.
      const ref = pool.refs[urn];
      if (ref && !resourceRefs.some((existing) => resourceRefToUrn(existing) === urn)) resourceRefs.push(ref);
      continue;
    }
    const ref = pool.refs[urn];
    if (ref && !resourceRefs.some((existing) => resourceRefToUrn(existing) === urn)) resourceRefs.push(ref);
  }

  const entities: BodyEntity[] = [];
  if (format === 'nimbalystMarkdown') {
    for (const { urn, start, end } of occurrences) {
      const person = pool.people[urn];
      if (person) {
        entities.push({ start, end, kind: 'userMention', userId: person.userId });
        continue;
      }
      const agent = pool.agents[urn];
      if (agent) {
        entities.push({ start, end, kind: 'agentMention', sessionId: agent.sessionId });
        continue;
      }
      const refIndex = resourceRefs.findIndex((ref) => resourceRefToUrn(ref) === urn);
      if (refIndex !== -1) entities.push({ start, end, kind: 'resource', refIndex });
    }
  }

  return {
    body: {
      version: 1,
      format,
      text,
      ...(entities.length > 0 ? { entities } : {}),
    },
    resourceRefs,
    mentionedUserIds,
    mentionedAgentSessionIds,
  };
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function addPersonToPool(pool: DraftPool, person: PersonHandle): { pool: DraftPool; urn: string } {
  const urn = mentionUrn(person.userId);
  return { pool: { ...pool, people: { ...pool.people, [urn]: person } }, urn };
}

export function addAgentToPool(
  pool: DraftPool,
  agent: AgentHandle,
  orgId: string,
): { pool: DraftPool; urn: string } {
  const urn = agentMentionUrn(agent.sessionId);
  const ref: ResourceRef = { orgId, kind: 'session', sourceId: agent.sessionId };
  return {
    pool: { ...pool, agents: { ...pool.agents, [urn]: agent }, refs: { ...pool.refs, [urn]: ref } },
    urn,
  };
}

export function addRefToPool(pool: DraftPool, ref: ResourceRef): { pool: DraftPool; urn: string } {
  const urn = resourceRefToUrn(ref);
  return { pool: { ...pool, refs: { ...pool.refs, [urn]: ref } }, urn };
}

/** Composer-inserted token: human-readable label, unambiguous target. */
export function labeledToken(label: string, urn: string): string {
  // Brackets in a label would terminate the link early and silently split the
  // token, so they are the one thing that has to be neutralized.
  return `[${label.replace(/[[\]]/g, '')}](${urn})`;
}

export interface TextEdit {
  text: string;
  caret: number;
}

/** Replace `[from, to)` with `insert`, returning the new caret position. */
export function replaceRange(text: string, from: number, to: number, insert: string): TextEdit {
  return { text: `${text.slice(0, from)}${insert}${text.slice(to)}`, caret: from + insert.length };
}

export interface ActiveTrigger {
  kind: 'mention' | 'emoji';
  /** Index of the `@` or `:` that opened it. */
  start: number;
  /** Caret index, exclusive end of the query. */
  end: number;
  query: string;
}

/**
 * Which autocomplete, if any, the caret is currently inside.
 *
 * A trigger only counts at a word boundary, so an email address does not open
 * the mention picker and a `10:30` timestamp does not open the emoji list.
 */
export function detectTrigger(text: string, caret: number): ActiveTrigger | null {
  for (let index = caret - 1; index >= 0 && caret - index <= 48; index -= 1) {
    const char = text[index];
    if (char === '\n' || char === ' ' || char === '\t') return null;
    if (char !== '@' && char !== ':') continue;

    const previous = index === 0 ? '' : text[index - 1];
    if (previous !== '' && !/[\s(]/.test(previous)) return null;

    const query = text.slice(index + 1, caret);
    if (char === '@') {
      if (/[^\w.\-]/.test(query)) return null;
      return { kind: 'mention', start: index, end: caret, query };
    }
    // A completed `:shortcode:` is already resolved; do not reopen on it.
    if (query.includes(':')) return null;
    if (query.length === 0) return null;
    if (/[^a-z0-9_+-]/.test(query)) return null;
    return { kind: 'emoji', start: index, end: caret, query };
  }
  return null;
}
