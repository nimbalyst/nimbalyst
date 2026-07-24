import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';

export interface MetaAgentSessionResult {
  id: string;
  provider: string;
}

/**
 * Create a meta-agent session via IPC.
 * Returns the session ID and resolved provider on success, null on failure.
 */
export async function createMetaAgentSession(
  workspacePath: string,
  defaultModel: string | null
): Promise<MetaAgentSessionResult | null> {
  const sessionId = crypto.randomUUID();
  const parsedModel = defaultModel ? ModelIdentifier.tryParse(defaultModel) : null;
  const provider = parsedModel?.provider || 'claude-code';

  try {
    const result = await window.electronAPI.invoke('sessions:create', {
      session: {
        id: sessionId,
        provider,
        model: defaultModel,
        title: 'Meta Agent',
        agentRole: 'meta-agent',
      },
      workspaceId: workspacePath,
    });

    if (result?.success && result.id) {
      return { id: result.id, provider };
    }
    return null;
  } catch (error) {
    console.error('[createMetaAgentSession] Failed:', error);
    return null;
  }
}
