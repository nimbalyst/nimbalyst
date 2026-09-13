// @vitest-environment node
import { expect, it, vi } from 'vitest';
const { provider } = vi.hoisted(() => ({ provider: {
  on: vi.fn(), initialize: vi.fn(async () => {}),
  sendMessage: vi.fn(async function* () { yield {type: 'text', content: 'image received'}; }),
} }));
vi.mock('../host/nodeHost.js', () => ({ registerNodeHostEnvironment: vi.fn() }));
vi.mock('../host/claudeCodeDeps.js', () => ({ registerClaudeCodeDeps: vi.fn() }));
vi.mock('../db/openDatabase.js', () => ({ openDatabase: vi.fn() }));
vi.mock('@nimbalyst/runtime/ai/server/SessionManager', () => ({ SessionManager: class {} }));
vi.mock('@nimbalyst/runtime/ai/server/providers/ClaudeCodeProvider', () => ({ ClaudeCodeProvider: class { constructor() { return provider; } } }));
import { NimbalystNode } from '../NimbalystNode.js';

it('supplies staged attachments in the provider attachment argument while resuming from host metadata', async () => {
  const node = Object.assign(Object.create(NimbalystNode.prototype), {
    sessionStore: {get: async () => ({id: 'remote', mode: 'agent', model: 'claude-code:sonnet'})},
    db: {prepare: () => ({get: () => ({count: 2})})},
    config: {},
  }) as NimbalystNode;
  const attachments = [{id: 'image', filename: 'image.png', filepath: '/private/image.png', mimeType: 'image/png', size: 3, type: 'image' as const, addedAt: 1}];
  const result = await node.runTurn({sessionId: 'remote', workspacePath: '/checkout', prompt: 'Read the image', attachments});
  expect(provider.sendMessage).toHaveBeenCalledWith('Read the image', expect.objectContaining({mode: 'agent'}), 'remote', [], '/checkout', attachments);
  expect(result.text).toBe('image received');
});
