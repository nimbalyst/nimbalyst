import { vi, describe, it, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { AgentMessagesRepository } from '../packages/runtime/src/storage/repositories/AgentMessagesRepository';
import { BaseAgentProvider } from '../packages/runtime/src/ai/server/providers/BaseAgentProvider';
import type {
  CreateAgentMessageInput,
  AgentMessage,
} from '../packages/runtime/src/ai/server/types';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Make vitest globals available globally
(global as any).describe = describe;
(global as any).it = it;
(global as any).test = test;
(global as any).expect = expect;
(global as any).beforeEach = beforeEach;
(global as any).afterEach = afterEach;
(global as any).beforeAll = beforeAll;
(global as any).afterAll = afterAll;
(global as any).vi = vi;

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

// Mock window.matchMedia if not available
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// Mock IntersectionObserver if not available
if (typeof window !== 'undefined' && !window.IntersectionObserver) {
  // @ts-ignore
  window.IntersectionObserver = class IntersectionObserver {
    constructor() {}
    disconnect() {}
    observe() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
  };
}

// Mock ResizeObserver if not available  
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  // @ts-ignore
  window.ResizeObserver = class ResizeObserver {
    constructor() {}
    disconnect() {}
    observe() {}
    unobserve() {}
  };
}

// Mermaid and other SVG tooling rely on getBBox, which jsdom does not implement.
if (typeof window !== 'undefined' && typeof SVGElement !== 'undefined' && !(SVGElement.prototype as any).getBBox) {
  (SVGElement.prototype as any).getBBox = function() {
    const text = (this as SVGElement).textContent || '';
    return {
      x: 0,
      y: 0,
      width: Math.max(1, text.length * 8),
      height: 16,
    };
  };
}

// Mock CSS imports
vi.mock('*.css', () => ({}));
