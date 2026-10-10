/**
 * `list_citable_inputs`: the human inputs of the calling session that a page
 * may cite (Decision 18) -- the person's prompts, their answers to questions
 * (with what they typed), and people's comments on the shared pages this
 * session worked on. Each comes with a stable key, a snapshot and the citation
 * markdown to paste. Listing cites nothing; the agent decides what to cite.
 *
 * Dependencies are injected so the tool runs in a node test without Electron;
 * `listCitableInputsHandler.ts` supplies the real ones.
 */

import type { CitableInput } from './citableRawRows';
import type { CitableInputKind } from './citationMarkdown';
import {
  citableCommentInputs,
  commenterEmailLookup,
  type CommentListResult,
  type TeamMemberIdentity,
} from './citableCommentInputs';
import { listSessionCitableInputs, type CitableRowsDb } from './citableSessionInputs';

export const LIST_CITABLE_INPUTS_TOOL_NAME = 'list_citable_inputs';

export const LIST_CITABLE_INPUTS_TOOL_SCHEMA = {
  name: LIST_CITABLE_INPUTS_TOOL_NAME,
  description:
    "List what people said in this session that a page may cite: the user's prompts, their answers to AskUserQuestion / PromptForUserInput (including text they typed), and people's comments on the shared pages this session read or edited. Each entry has a stable key, who (name and email when known), when, context, the quote, and `citation` -- ready markdown to paste right after the sentence it supports. Nothing is cited automatically; cite only what a sentence actually came from. Agent-sent prompts are never listed.",
  inputSchema: {
    type: 'object',
    properties: {
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['prompt', 'answer', 'comment'] },
        description: 'Only these kinds. Default: all three.',
      },
      query: {
        type: 'string',
        description: 'Case-insensitive text to match in the quote, answer or context.',
      },
      pages: {
        type: 'array',
        items: { type: 'string' },
        description: 'collab:// URIs whose comments to include. Default: the shared pages this session read or edited.',
      },
      limit: {
        type: 'number',
        description: 'Maximum entries, newest kept (default 50, max 200).',
      },
    },
    required: [] as string[],
  },
};

export interface ListCitableInputsArgs {
  kinds?: unknown;
  query?: unknown;
  pages?: unknown;
  limit?: unknown;
}

export interface ListCitableInputsDeps {
  db: () => CitableRowsDb | null;
  /** The person this session belongs to: their name as it should read in a page, and their email. */
  author: (workspacePath: string) => { name: string; email?: string };
  /** One page's comment threads, or an error message. */
  readComments: (pageUri: string, workspacePath: string) => Promise<CommentListResult | { error: string }>;
  /** The workspace team's roster, to give commenters an email. Empty without a team. */
  teamMembers: (workspacePath: string) => Promise<TeamMemberIdentity[]>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_DISCOVERED_PAGES = 10;
const KINDS: CitableInputKind[] = ['prompt', 'answer', 'comment'];

/** Shared pages this session named in a collab tool call, most recent last. */
export async function pagesTouchedBySession(db: CitableRowsDb, sessionId: string): Promise<string[]> {
  const { rows } = await db.query<{ content: string }>(
    `SELECT content FROM ai_agent_messages
     WHERE session_id = $1 AND direction = 'output'
       AND (content LIKE $2 OR content LIKE $3 OR content LIKE $4)
     ORDER BY id ASC`,
    [sessionId, '%applyCollabDocEdit%', '%readCollabDoc%', '%CollabDocComment%'],
  );
  const pages: string[] = [];
  for (const row of rows) {
    for (const match of row.content.matchAll(/"filePath":"(collab:\/\/[^"\\]+)"/g)) {
      const uri = match[1]!;
      const existing = pages.indexOf(uri);
      if (existing >= 0) pages.splice(existing, 1);
      pages.push(uri);
    }
  }
  return pages.slice(-MAX_DISCOVERED_PAGES);
}

function requestedKinds(value: unknown): Set<CitableInputKind> {
  if (!Array.isArray(value) || value.length === 0) return new Set(KINDS);
  return new Set(KINDS.filter((kind) => value.includes(kind)));
}

export async function runListCitableInputs(
  args: ListCitableInputsArgs | undefined,
  context: { sessionId: string; workspacePath: string },
  deps: ListCitableInputsDeps,
): Promise<{ inputs: CitableInput[]; notes: string[] }> {
  const { sessionId, workspacePath } = context;
  if (!sessionId) throw new Error('list_citable_inputs needs the calling session');
  const db = deps.db();
  if (!db) throw new Error('Database not initialized');

  const kinds = requestedKinds(args?.kinds);
  const notes: string[] = [];
  let inputs: CitableInput[] = [];

  if (kinds.has('prompt') || kinds.has('answer')) {
    const author = deps.author(workspacePath);
    const sessionInputs = await listSessionCitableInputs(db, sessionId, { author: author.name, authorEmail: author.email });
    inputs.push(...sessionInputs.filter((input) => kinds.has(input.kind)));
  }

  if (kinds.has('comment')) {
    const pages = Array.isArray(args?.pages)
      ? args!.pages.filter((page): page is string => typeof page === 'string' && page.startsWith('collab://'))
      : await pagesTouchedBySession(db, sessionId);
    let emailFor: ReturnType<typeof commenterEmailLookup> | null = null;
    for (const page of pages) {
      const list = await deps.readComments(page, workspacePath);
      if ('error' in list) {
        notes.push(`Comments on ${page} could not be read: ${list.error}`);
        continue;
      }
      if (!emailFor) {
        const members = await deps.teamMembers(workspacePath).catch((error: unknown) => {
          notes.push(`Commenters' emails are missing: the team roster could not be read (${error instanceof Error ? error.message : String(error)}).`);
          return [];
        });
        emailFor = commenterEmailLookup(members);
      }
      inputs.push(...citableCommentInputs(page, list, sessionId, emailFor));
    }
  }

  const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
  if (query) {
    inputs = inputs.filter((input) =>
      [input.quote, input.answer ?? '', input.context].some((text) => text.toLowerCase().includes(query)),
    );
  }

  inputs.sort((a, b) => a.at.localeCompare(b.at));
  const requested = typeof args?.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);
  return { inputs: inputs.slice(-limit), notes };
}
