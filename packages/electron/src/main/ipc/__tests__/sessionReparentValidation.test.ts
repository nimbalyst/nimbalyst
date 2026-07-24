import { describe, expect, it } from 'vitest';
import {
  validateSessionReparent,
  type ReparentValidationNode,
} from '../sessionReparentValidation';

function node(
  id: string,
  overrides: Partial<ReparentValidationNode> = {},
): ReparentValidationNode {
  return {
    id,
    workspacePath: '/workspace',
    sessionType: 'session',
    parentSessionId: null,
    worktreeId: null,
    childCount: 0,
    metadata: {},
    ...overrides,
  };
}

describe('sessions:set-parent hierarchy validation', () => {
  const destination = node('destination', { sessionType: 'workstream' });

  it('rejects typed and legacy structural sources', () => {
    expect(validateSessionReparent({
      source: node('typed', { sessionType: 'workstream' }),
      destination,
      newParentId: destination.id,
      workspacePath: '/workspace',
    })).toMatch(/container/i);
    expect(validateSessionReparent({
      source: node('legacy', { metadata: { isWorkstreamRoot: true } }),
      destination,
      newParentId: destination.id,
      workspacePath: '/workspace',
    })).toMatch(/container/i);
    expect(validateSessionReparent({
      source: node('child-bearing', { childCount: 1 }),
      destination,
      newParentId: destination.id,
      workspacePath: '/workspace',
    })).toMatch(/container/i);
  });

  it('rejects self-parent, destination-child, and cross-workspace moves', () => {
    expect(validateSessionReparent({
      source: node('source'),
      destination: node('source'),
      newParentId: 'source',
      workspacePath: '/workspace',
    })).toMatch(/own parent/i);
    expect(validateSessionReparent({
      source: node('source'),
      destination: node('nested', { parentSessionId: 'root' }),
      newParentId: 'nested',
      workspacePath: '/workspace',
    })).toMatch(/already a child/i);
    expect(validateSessionReparent({
      source: node('source'),
      destination: node('other', { workspacePath: '/other' }),
      newParentId: 'other',
      workspacePath: '/workspace',
    })).toMatch(/different workspace/i);
  });

  it('rejects worktree-depth violations and preserves valid moves', () => {
    expect(validateSessionReparent({
      source: node('worktree-source', { worktreeId: 'wt-1' }),
      destination,
      newParentId: destination.id,
      workspacePath: '/workspace',
    })).toMatch(/worktree-resident/i);
    expect(validateSessionReparent({
      source: node('source'),
      destination: node('worktree-destination', { worktreeId: 'wt-1' }),
      newParentId: 'worktree-destination',
      workspacePath: '/workspace',
    })).toMatch(/worktree-resident/i);
    expect(validateSessionReparent({
      source: node('source', { parentSessionId: 'old-parent' }),
      destination,
      newParentId: destination.id,
      workspacePath: '/workspace',
    })).toBeNull();
    expect(validateSessionReparent({
      source: node('source', { parentSessionId: 'old-parent' }),
      destination: null,
      newParentId: null,
      workspacePath: '/workspace',
    })).toBeNull();
  });
});
