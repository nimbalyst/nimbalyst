import { describe, expect, it } from 'vitest';
import {
  serializeSessionReparentMutation,
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

  it('serializes validation and writes so concurrent moves cannot create a third level', async () => {
    const parents = new Map<string, string | null>([
      ['root', null],
      ['destination', null],
      ['source', null],
    ]);
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>(resolve => {
      releaseFirstWrite = resolve;
    });
    let firstValidated!: () => void;
    const firstValidatedGate = new Promise<void>(resolve => {
      firstValidated = resolve;
    });
    let secondEntered = false;

    const hierarchyNode = (id: string): ReparentValidationNode => node(id, {
      parentSessionId: parents.get(id) ?? null,
      childCount: Array.from(parents.values()).filter(parentId => parentId === id).length,
    });
    const move = async (
      sourceId: string,
      destinationId: string,
      pauseBeforeWrite = false,
    ): Promise<string | null> => {
      const error = validateSessionReparent({
        source: hierarchyNode(sourceId),
        destination: hierarchyNode(destinationId),
        newParentId: destinationId,
        workspacePath: '/workspace',
      });
      if (error) return error;
      if (pauseBeforeWrite) {
        firstValidated();
        await firstWriteGate;
      }
      parents.set(sourceId, destinationId);
      return null;
    };

    const first = serializeSessionReparentMutation(
      () => move('source', 'destination', true),
    );
    await firstValidatedGate;
    const second = serializeSessionReparentMutation(async () => {
      secondEntered = true;
      return move('destination', 'root');
    });

    await Promise.resolve();
    expect(secondEntered).toBe(false);
    releaseFirstWrite();

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toMatch(/container/i);
    expect(parents.get('source')).toBe('destination');
    expect(parents.get('destination')).toBeNull();
  });
});
