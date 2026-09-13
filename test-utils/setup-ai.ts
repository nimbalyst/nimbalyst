import { beforeEach } from 'vitest';
import { AgentMessagesRepository } from '../packages/runtime/src/storage/repositories/AgentMessagesRepository';
import { BaseAgentProvider } from '../packages/runtime/src/ai/server/providers/BaseAgentProvider';
import type {
  CreateAgentMessageInput,
  AgentMessage,
} from '../packages/runtime/src/ai/server/types';

// Provider execution fixtures are loaded by the Node project, not every UI test.
beforeEach(() => {
  const bySession = new Map<string, AgentMessage[]>();

  AgentMessagesRepository.setStore({
    async create(message: CreateAgentMessageInput): Promise<void> {
      const sessionMessages = bySession.get(message.sessionId) ?? [];
      const now = new Date().toISOString();
      sessionMessages.push({
        id: `${message.sessionId}_${sessionMessages.length + 1}`,
        sessionId: message.sessionId,
        role: message.role,
        content: message.content,
        timestamp: now,
        providerMetadata: message.providerMetadata,
        toolCall: message.toolCall,
        toolResult: message.toolResult,
        model: message.model,
        inputTokens: message.inputTokens,
        outputTokens: message.outputTokens,
        durationMs: message.durationMs,
      } as AgentMessage);
      bySession.set(message.sessionId, sessionMessages);
    },
    async list(sessionId: string): Promise<AgentMessage[]> {
      return [...(bySession.get(sessionId) ?? [])];
    },
    async getMessageCounts(sessionIds: string[]): Promise<Map<string, number>> {
      const counts = new Map<string, number>();
      for (const sessionId of sessionIds) {
        counts.set(sessionId, (bySession.get(sessionId) ?? []).length);
      }
      return counts;
    },
  });

  BaseAgentProvider.setTrustChecker(() => ({
    trusted: true,
    mode: 'ask',
  }));
  BaseAgentProvider.setPermissionPatternSaver(async () => {});
  BaseAgentProvider.setPermissionPatternChecker(async () => false);
  BaseAgentProvider.setSecurityLogger(() => {});
});

