// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ProjectIndex } from '../projectIndex';
import type { IndexSource } from '../types';
import type { ProjectGraphNode } from '../../types';
import { createTestHost } from '../../adapters/__tests__/testHost';

function record(id: string): ProjectGraphNode {
  return { id, type: 'task', label: id, category: 'delivery', source: 'tracker', visibility: 'local' };
}
function fakeSource({ id = 'trackers', prefix = 'tracker:', ids }: { id?: IndexSource['id']; prefix?: string; ids: string[] }): IndexSource {
  return {
    id, label: id,
    prepare: async () => ({ availability: 'available', total: ids.length }),
    page: async () => ({ records: ids.map(id => record(prefix + id)), edges: [], rows: ids.length }),
    owns: id => id.startsWith(prefix),
  };
}
function makeIndex(sources: IndexSource[]) {
  const { host } = createTestHost();
  return { index: new ProjectIndex(host, { cache: false }, { sources }) };
}


describe('on-demand reads cannot outlive their index', () => {
  it.each(['refresh', 'cancel', 'dispose'] as const)('fences resolution and detail returns on %s', async (action) => {
    const source = fakeSource({ ids: ['a'] });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    source.resolve = async () => { await gate; return record('tracker:late'); };
    source.loadDetail = async () => { await gate; return { body: 'late' }; };
    const { index } = makeIndex([source]);
    await index.load();
    const resolving = index.resolveNode('tracker:late');
    const detail = index.loadDetail('tracker:a');
    if (action === 'refresh') await index.refresh();
    else index[action]();
    release();
    expect(await Promise.all([resolving, detail])).toEqual([null, null]);
    expect(index.getState().records.map(r => r.id)).toEqual(['tracker:a']);
  });

  it('fences git evidence across a refresh and merges overlapping lookups', async () => {
    const releases: Array<() => void> = [];
    const { host } = createTestHost({ execs: [{ match: /--name-only/, handle: async ({ command }) => {
      await new Promise<void>(r => releases.push(r));
      const sha = command.includes("'aaaa'") ? 'aaaa' : 'bbbb';
      return { stdout: `__COMMIT__${sha}\ndocs/${sha}.md\n` };
    } }] });
    const source = fakeSource({ id: 'git', prefix: 'commit:', ids: ['aaaa', 'bbbb'] });
    const index = new ProjectIndex(host, { cache: false }, { sources: [source] });
    await index.load();
    const stale = index.loadCommitEvidence({ shas: ['aaaa'] });
    await index.refresh();
    releases.shift()!();
    expect(await stale).toMatchObject({ covered: 0 });
    expect(index.getState().edges).toHaveLength(0);
    const first = index.loadCommitEvidence({ shas: ['aaaa'] });
    const second = index.loadCommitEvidence({ shas: ['bbbb'] });
    releases.shift()!();
    await first;
    releases.shift()!();
    await second;
    expect(index.getState().edges.map(e => e.sourceId).sort()).toEqual(['commit:aaaa', 'commit:bbbb']);
    expect(index.getState().coverage.git.detailLoaded).toBe(2);
  });
});
