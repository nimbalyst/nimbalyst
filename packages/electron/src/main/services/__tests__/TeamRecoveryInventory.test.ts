// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { collectRecoveryInventory } from '../TeamRecoveryInventory';
import type { TeamRecoveryDiagnostics } from '@nimbalyst/collab-protocol';

const diagnostics: TeamRecoveryDiagnostics = { version: 1, orgId: 'org', rawCustodyMode: null, status: 'legacy', keyPresent: false, keyProbe: 'absent', dekEpoch: null, dekFingerprint: null, projects: [{ projectId: 'registry', teamProjectId: 'project' }] };
const entry = { id: 'doc', revision: 'a'.repeat(64), fingerprint: null, deleted: false };
describe('recovery inventory collection', () => {
  it('walks every project and document room, including tracker body IDs', async () => {
    const calls: string[] = [];
    const report = await collectRecoveryInventory(diagnostics, async (kind, targetId) => {
      calls.push(`${kind}:${targetId}`);
      return { version: 1, kind, entries: kind === 'documents' ? [entry] : kind === 'items' ? [{ ...entry, id: 'item', issueKey: 'NIM-1', issueNumber: 1 }] : [], nextCursor: null };
    });
    expect(calls).toContain('items:project');
    expect(calls).toContain('updates:doc');
    expect(calls).toContain('updates:tracker-content/item');
    expect(report.rooms).toHaveLength(12);
  });
  it('inspects server bodies for locally keyed items absent from the server tracker index', async () => {
    const calls: string[] = [];
    await collectRecoveryInventory(diagnostics, async (kind, id) => { calls.push(`${kind}:${id}`); return { version: 1, kind, entries: [], nextCursor: null }; }, ['tracker-content/local-only']);
    expect(calls).toContain('snapshots:tracker-content/local-only');
    expect(calls).toContain('assets:tracker-content/local-only');
  });
  it('refuses repeated cursors and malformed pages instead of accepting partial coverage', async () => {
    await expect(collectRecoveryInventory(diagnostics, async kind => ({ version: 1, kind, entries: [entry], nextCursor: 'doc' }))).rejects.toThrow('progress');
    await expect(collectRecoveryInventory(diagnostics, async kind => ({ version: 1, kind, entries: [{ ...entry, revision: 'wrong' }], nextCursor: null }))).rejects.toThrow('Invalid');
  });
});
