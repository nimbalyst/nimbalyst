import { parseCodexToolLookupId } from '../toolLookupIds';
import type { ToolCallStartedDescriptor } from './parsers/IRawMessageParser';
import type { ITranscriptEventStore, TranscriptEvent } from './types';

const COMMIT_TOOL = 'developer_git_commit_proposal';
const isCommitTool = (name: unknown): boolean =>
  typeof name === 'string' && (name === COMMIT_TOOL || name.endsWith(`__${COMMIT_TOOL}`));

/** Join the host's early proposal with the provider's notification of that call.
 * Only an active host/native pair may introduce an alias. Never collapse two
 * native calls just because Codex reused a raw item ID in another turn.
 */
export async function reconcileCodexCommitProposal(
  store: ITranscriptEventStore,
  sessionId: string,
  desc: ToolCallStartedDescriptor,
): Promise<TranscriptEvent | null> {
  const incomingId = desc.providerToolCallId;
  if (!incomingId) return null;
  const lookup = parseCodexToolLookupId(incomingId);
  if (!lookup || !isCommitTool(desc.toolName)) return null;
  const existing = await store.findByProviderToolCallId(incomingId, sessionId)
    ?? await store.findActiveToolCallByRawProviderId(lookup.itemId, sessionId);
  if (!existing) return null;
  const payload = existing.payload as Record<string, unknown>;
  if (!isCommitTool(payload.toolName)) return null;
  const incomingIsHost = desc.toolName === COMMIT_TOOL;
  const existingIsHost = payload.toolName === COMMIT_TOOL;
  if (incomingIsHost === existingIsHost) return null;

  // The host resolves absolute file paths and the actual target repository.
  // Keep those authoritative arguments regardless of notification ordering.
  const aliases = Array.isArray(payload.providerToolCallAliases)
    ? payload.providerToolCallAliases.filter((id): id is string => typeof id === 'string') : [];
  await store.mergeEventPayload(existing.id, {
    providerToolCallAliases: [...new Set([...aliases, incomingId])],
    ...(incomingIsHost ? { arguments: desc.arguments } : {
      toolName: desc.toolName, toolDisplayName: desc.toolDisplayName,
      mcpServer: desc.mcpServer, mcpTool: desc.mcpTool,
    }),
  });
  return store.getEventById(existing.id);
}

/** #1890: Claude's host row and the SDK's tool_use share one provider id. When
 * the SDK row was parsed first, merge the host's resolved arguments (absolute
 * files, repoPath, targetWorktree, autoApproved) into that event; the widget
 * reads them to decide between the auto-commit spinner and the approval card.
 * The host-first order needs nothing: the parser drops the later SDK row.
 */
export async function reconcileClaudeCommitProposal(
  store: ITranscriptEventStore,
  sessionId: string,
  desc: ToolCallStartedDescriptor,
): Promise<TranscriptEvent | null> {
  const id = desc.providerToolCallId;
  if (!id || desc.toolName !== COMMIT_TOOL || parseCodexToolLookupId(id)) return null;
  const existing = await store.findByProviderToolCallId(id, sessionId);
  if (!existing) return null;
  const payload = existing.payload as Record<string, unknown>;
  if (!isCommitTool(payload.toolName) || payload.toolName === COMMIT_TOOL) return null;
  await store.mergeEventPayload(existing.id, { arguments: desc.arguments });
  return store.getEventById(existing.id);
}
