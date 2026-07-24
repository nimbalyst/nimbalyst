import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../SessionManager';
import type {
  SessionStore,
  CreateSessionPayload,
  SessionMeta,
  UpdateSessionMetadataPayload,
} from '../../adapters/sessionStore';
import { shouldBlockStartedSessionProviderSwitch, type SessionData, type TranscriptViewMessage } from '../types';

class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();

  async ensureReady(): Promise<void> {}

  async create(payload: CreateSessionPayload): Promise<void> {
    const now = Date.now();
    this.sessions.set(payload.id, {
      id: payload.id,
      provider: payload.provider,
      model: payload.model,
      title: payload.title,
      draftInput: undefined,
      messages: [],
      createdAt: now,
      updatedAt: now,
      metadata: {
        workspaceId: payload.workspaceId,
        filePath: payload.filePath,
        documentContext: payload.documentContext,
        providerConfig: payload.providerConfig,
        providerSessionId: payload.providerSessionId,
      },
    });
  }

  async appendMessage(sessionId: string, message: TranscriptViewMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    session.messages.push(message);
    session.updatedAt = Date.now();
  }

  async replaceMessages(sessionId: string, messages: TranscriptViewMessage[]): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    session.messages = [...messages];
    session.updatedAt = Date.now();
  }

  async updateMetadata(sessionId: string, metadata: UpdateSessionMetadataPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    session.metadata = {
      ...(session.metadata ?? {}),
      ...metadata,
    } as SessionData['metadata'];
    if (metadata.draftInput !== undefined) {
      session.draftInput = metadata.draftInput;
    }
    session.updatedAt = Date.now();
  }

  async get(sessionId: string): Promise<SessionData | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  private toMeta(session: SessionData): SessionMeta {
    return {
      id: session.id,
      provider: session.provider,
      model: session.model,
      title: session.title || 'Untitled Session',
      sessionType: session.sessionType || 'session',
      workspaceId: (session.metadata as any)?.workspaceId || '',
      worktreeId: session.worktreeId || null,
      parentSessionId: session.parentSessionId || null,
      childCount: 0,
      uncommittedCount: 0,
      createdAt: session.createdAt || 0,
      updatedAt: session.updatedAt || 0,
      messageCount: session.messages.length,
      isArchived: session.isArchived || false,
      isPinned: session.isPinned || false,
    };
  }

  async list(workspaceId: string): Promise<SessionMeta[]> {
    return [...this.sessions.values()]
      .filter(session => (session.metadata as any)?.workspaceId === workspaceId)
      .map(session => this.toMeta(session))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async search(workspaceId: string, query: string): Promise<SessionMeta[]> {
    // Simple in-memory search for testing
    if (!query || query.trim().length === 0) {
      return this.list(workspaceId);
    }

    const lowerQuery = query.toLowerCase();
    return [...this.sessions.values()]
      .filter(session => {
        if ((session.metadata as any)?.workspaceId !== workspaceId) {
          return false;
        }
        // Search in title
        if (session.title?.toLowerCase().includes(lowerQuery)) {
          return true;
        }
        // Search in messages
        return session.messages.some(msg => {
          const content = msg.text ?? '';
          return content.toLowerCase().includes(lowerQuery);
        });
      })
      .map(session => this.toMeta(session))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

describe('SessionManager (runtime server)', () => {
  let store: InMemorySessionStore;
  let manager: SessionManager;

  beforeEach(async () => {
    store = new InMemorySessionStore();
    manager = new SessionManager(store);
    await manager.initialize();
  });

  it('returns persisted tool messages when listing sessions', async () => {
    const session = await manager.createSession('claude-code', { content: 'text' }, 'ws');

    await manager.addMessage({ role: 'user', content: 'hello', timestamp: Date.now() }, session.id);
    await manager.addMessage({
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolCall: {
        name: 'applyDiff',
        arguments: { replacements: [{ oldText: 'a', newText: 'b' }] },
        result: { success: true },
      },
    }, session.id);

    const sessions = await manager.getSessions('ws');
    expect(sessions).toHaveLength(1);
    expect(Array.isArray(sessions[0].messages)).toBe(true);
  });

  it('blocks switching a started Claude Agent session to OpenAI Codex', async () => {
    const session = await manager.createSession('claude-code', { content: 'text' }, 'ws');
    await manager.addMessage({ role: 'user', content: 'hello', timestamp: Date.now() }, session.id);

    await expect(
      manager.updateSessionProviderAndModel(session.id, 'openai-codex', 'openai-codex:openai-codex-cli')
    ).rejects.toThrow('Start a new session instead');
  });

  it('blocks switching a started Claude Agent session via model-only update', async () => {
    const session = await manager.createSession('claude-code', { content: 'text' }, 'ws');
    await manager.addMessage({ role: 'user', content: 'hello', timestamp: Date.now() }, session.id);

    await expect(
      manager.updateSessionModel(session.id, 'openai-codex:openai-codex-cli')
    ).rejects.toThrow('Start a new session instead');
  });

  it('allows switching models within the same provider after a session has started', async () => {
    const session = await manager.createSession('claude-code', { content: 'text' }, 'ws');
    await manager.addMessage({ role: 'user', content: 'hello', timestamp: Date.now() }, session.id);

    await expect(
      manager.updateSessionProviderAndModel(session.id, 'claude-code', 'claude-code:opus')
    ).resolves.toBeUndefined();
  });

  it('only blocks started provider switches when an agent provider is involved', () => {
    expect(shouldBlockStartedSessionProviderSwitch('claude-code', 'openai-codex', true)).toBe(true);
    expect(shouldBlockStartedSessionProviderSwitch('openai-codex', 'claude-code', true)).toBe(true);
    expect(shouldBlockStartedSessionProviderSwitch('claude-code', 'claude', true)).toBe(true);
    expect(shouldBlockStartedSessionProviderSwitch('claude', 'openai', true)).toBe(false);
    expect(shouldBlockStartedSessionProviderSwitch('claude-code', 'openai-codex', false)).toBe(false);
  });

});
