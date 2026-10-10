/**
 * Production wiring for `list_citable_inputs`: the app database, the signed-in
 * person's name, and comment threads read through the same renderer path as
 * `readCollabDocComments`.
 */

import { getDatabase } from '../../database/initialize';
import { handleReadCollabDocComments } from '../../mcp/tools/editorToolHandlers';
import { getCurrentIdentity } from '../TrackerIdentityService';
import { findTeamForWorkspace, listMembers } from '../TeamService';
import type { CommentListResult, TeamMemberIdentity } from './citableCommentInputs';
import type { CitableRowsDb } from './citableSessionInputs';
import { runListCitableInputs, type ListCitableInputsArgs, type ListCitableInputsDeps } from './listCitableInputs';

async function readComments(pageUri: string, workspacePath: string): Promise<CommentListResult | { error: string }> {
  const result = await handleReadCollabDocComments({ filePath: pageUri, limit: 100 }, workspacePath);
  const text = result.content.find((part) => part.type === 'text')?.text ?? '';
  try {
    const parsed = JSON.parse(text);
    if (result.isError) return { error: parsed?.error?.message ?? parsed?.error?.code ?? text };
    return parsed as CommentListResult;
  } catch {
    return { error: text || 'Unreadable comment list' };
  }
}

/** The workspace team's members; a comment's `userId` is its author's member id in that team. */
async function teamMembers(workspacePath: string): Promise<TeamMemberIdentity[]> {
  if (!workspacePath) return [];
  const team = await findTeamForWorkspace(workspacePath);
  if (!team) return [];
  const { members } = await listMembers(team.orgId);
  return members.map((member) => ({ memberId: member.memberId, name: member.name, email: member.email }));
}

const productionDeps: ListCitableInputsDeps = {
  db: () => getDatabase() as CitableRowsDb | null,
  author: (workspacePath) => {
    const identity = getCurrentIdentity(workspacePath || undefined);
    return { name: identity.displayName || 'You', ...(identity.email ? { email: identity.email } : {}) };
  },
  readComments,
  teamMembers,
};

export async function handleListCitableInputs(
  args: ListCitableInputsArgs | undefined,
  sessionId: string,
  workspacePath: string,
): Promise<string> {
  const { inputs, notes } = await runListCitableInputs(args, { sessionId, workspacePath }, productionDeps);
  return JSON.stringify({ inputs, ...(notes.length > 0 ? { notes } : {}) }, null, 2);
}
