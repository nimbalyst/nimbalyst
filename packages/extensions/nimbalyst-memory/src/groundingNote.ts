/**
 * Pure builder for the voice-session grounding note.
 *
 * The voice context provider injects this at session start so the agent knows
 * (a) it has a project-knowledge memory and how to use it in a design
 * conversation, (b) the live state of that index, and (c) any durable facts to
 * keep in mind. Kept as a pure function (no host/engine imports) so it's unit
 * testable and the seam stays clean — `src/index.tsx` fetches the live status +
 * facts over the read bridge and passes them in.
 */

/** Live index status as returned by the backend `status` tool (subset used). */
export interface GroundingStatus {
  ready?: boolean;
  chunks?: number;
  denseChunks?: number;
  indexing?: boolean;
  lastEmbedError?: string | null;
  embedder?: { model?: string } | null;
  /** Set when ready === false (e.g. missing OpenAI key). */
  error?: string | null;
}

/** A durable fact (subset of the engine `Fact` shape). */
export interface GroundingFact {
  text: string;
  category?: string | null;
  priority?: number;
}

/**
 * Capability + brainstorm-loop choreography. Always injected so the agent acts
 * like a design partner, not a relay. The backend tools named here only exist
 * when this extension is enabled, so this guidance lives with the extension, not
 * in the core voice prompt.
 */
export const BRAINSTORM_CHOREOGRAPHY =
  'You have a project-knowledge memory of this codebase and can be a design ' +
  'partner, not just a relay. This is your DEFAULT source for project questions: ' +
  'before answering how the project works, what was decided, or what is in ' +
  'flight, call search_project_knowledge for the relevant design docs/plans/' +
  'CLAUDE.md and recall for durable facts. Do these BEFORE ask_coding_agent -- ' +
  'they answer in under a second, whereas the coding agent can take minutes. ' +
  'Only fall back to ask_coding_agent when memory returns nothing or the question ' +
  'truly needs live code inspection. Use remember to store decisions or ' +
  'preferences worth keeping. ' +
  'Brainstorm loop: when an idea is fleshed out, kick off a plan with ' +
  'submit_agent_prompt phrased as "/design <idea>"; when it finishes, call ' +
  'get_latest_plan and summarize it back so the user can refine it by voice; ' +
  'refine via submit_agent_prompt, then "/implement" the approved plan. While a ' +
  'task runs, use get_task_status to tell the user whether it is still working, ' +
  'waiting on them, or done.';

const MAX_FACTS = 8;

function statusLine(status: GroundingStatus): string | null {
  if (status.ready === false) {
    const reason = status.error ? ` ${status.error}` : '';
    return (
      'Project-knowledge index is not ready yet.' +
      reason +
      ' Searches may return nothing until it is configured/finished — rely on ' +
      'the conversation for now.'
    );
  }
  const chunks = status.chunks ?? 0;
  if (status.indexing) {
    return `Project-knowledge index is still building (${chunks} chunks so far); search results improve as it finishes.`;
  }
  let line = `Project-knowledge index ready: ${chunks} chunks (semantic + keyword search).`;
  if (status.lastEmbedError) {
    line +=
      ' Semantic search is currently degraded (an embedding error occurred) — keyword matches still work.';
  }
  return line;
}

/**
 * Build the grounding note from the live index status + top facts. Both are
 * optional: with neither, returns just the choreography (the static fallback).
 */
export function buildGroundingNote(opts: {
  status?: GroundingStatus | null;
  facts?: GroundingFact[];
}): string {
  const parts: string[] = [BRAINSTORM_CHOREOGRAPHY];

  if (opts.status) {
    const line = statusLine(opts.status);
    if (line) parts.push(line);
  }

  const facts = opts.facts ?? [];
  if (facts.length > 0) {
    const lines = facts.slice(0, MAX_FACTS).map((f) => `- ${f.text}`);
    parts.push(`Durable facts to keep in mind:\n${lines.join('\n')}`);
  }

  return parts.join('\n\n');
}
