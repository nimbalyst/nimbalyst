// @vitest-environment node
/**
 * Guards the file-tracking half of the Gemini provider.
 *
 * The failure this exists to catch is silent by construction: if the provider
 * stops emitting `pre_edit_snapshot` / `post_edit_snapshot`, the agent still
 * edits files correctly, the transcript still looks right, and only the Files
 * Edited sidebar and the diff view go empty — with no error logged anywhere.
 * That exact bug shipped in the first draft of `CursorAgentProvider`. There is
 * no runtime signal for it, so this test is the signal.
 *
 * The declared fidelity is asserted alongside, because the two are one
 * decision: `'structured'` switches the filesystem watcher OFF, and Gemini has
 * no delete or move tool, so a future change to `'structured'` here would make
 * every `rm` inside `run_command` invisible. See `providerFileTracking.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GeminiAntigravityProvider,
  type GeminiToolExecutorArgs,
} from '../GeminiAntigravityProvider';
import { AntigravityServerManager } from '../geminiAntigravity/AntigravityServerManager';
import {
  BUILTIN_FILE_CHANGE_FIDELITY,
  PROVIDER_EDIT_TOOL_NAMES,
  attributionModeForFileChangeFidelity,
} from '../../providerFileTracking';
import type { StreamChunk } from '../../types';

async function collect(stream: AsyncIterableIterator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const WRITE_TOOL = [{ type: 'function' as const, function: { name: 'write_file' } }];

describe('Gemini explicit model defaults', () => {
  afterEach(() => { GeminiAntigravityProvider.setServerConfigLoader(null); vi.restoreAllMocks(); });

  it('uses only the persisted Medium choice as a default and leaves missing choices unresolved', () => {
    GeminiAntigravityProvider.setServerConfigLoader(() => ({}));
    expect(GeminiAntigravityProvider.getDefaultModel()).toBe('');
    GeminiAntigravityProvider.setServerConfigLoader(() => ({
      defaultModel: 'antigravity-gemini-agent:gemini-3.8-flash-tiered',
    }));
    expect(GeminiAntigravityProvider.getDefaultModel()).toBe('antigravity-gemini-agent:gemini-3.8-flash-tiered');
  });

  it('restores saved real model IDs before the native server starts after an app restart', async () => {
    vi.spyOn(AntigravityServerManager.prototype, 'currentEndpoint').mockReturnValue(null);
    // No Antigravity app open: passive attach finds nothing and must not spawn.
    vi.spyOn(AntigravityServerManager.prototype, 'attachIfRunning').mockResolvedValue(null);
    const ensureRunning = vi.spyOn(AntigravityServerManager.prototype, 'ensureRunning');
    GeminiAntigravityProvider.setServerConfigLoader(() => ({
      savedModelIds: [
        'antigravity-gemini-agent:gemini-3.5-flash-lite',
        'antigravity-gemini-agent:gemini-3.8-flash-tiered',
        'antigravity-gemini-agent:gemini-3.1-pro-high',
      ],
    }));
    expect((await GeminiAntigravityProvider.getModels()).map(m => m.id)).toEqual([
      'antigravity-gemini-agent:gemini-3.5-flash-lite',
      'antigravity-gemini-agent:gemini-3.8-flash-tiered',
      'antigravity-gemini-agent:gemini-3.1-pro-high',
    ]);
    expect(ensureRunning).not.toHaveBeenCalled();
  });
});

describe('gemini file-tracking declaration', () => {
  it('declares tool-args so the watcher keeps attributing shell-driven changes', () => {
    // Gemini's toolset is read_file / list_files / search_files / write_file /
    // run_command: no delete, no move. Switching attribution off would drop
    // every removal and every build-step side effect.
    expect(BUILTIN_FILE_CHANGE_FIDELITY['antigravity-gemini-agent']).toBe('tool-args');
    expect(attributionModeForFileChangeFidelity('tool-args')).toBe('fuzzy');
  });

  it('names no edit tool, because its baseline comes from the write path instead', () => {
    // A name here would make MessageStreamingHandler write a disk-read tag for
    // the same toolUseId the authoritative snapshot uses, and the loser of that
    // race is silently discarded as a duplicate.
    expect(PROVIDER_EDIT_TOOL_NAMES['antigravity-gemini-agent']).toEqual([]);
  });
});

describe('GeminiAntigravityProvider edit snapshots', () => {
  let getModelResponse: import('vitest').MockInstance<
    AntigravityServerManager['getModelResponse']
  >;
  let provider: GeminiAntigravityProvider;

  beforeEach(async () => {
    getModelResponse = vi.spyOn(AntigravityServerManager.prototype, 'getModelResponse');
    provider = new GeminiAntigravityProvider();
    await provider.initialize({ model: 'gemini-3.8-flash-tiered' });
  });

  afterEach(() => {
    GeminiAntigravityProvider.setToolExecutor(null);
    provider.destroy();
    vi.restoreAllMocks();
  });

  function mockWriteTurn(fileWrite: {
    absPath: string;
    beforeContent: string | null;
    afterContent: string;
  }): void {
    getModelResponse
      .mockResolvedValueOnce(
        JSON.stringify({
          tool_call: {
            name: 'write_file',
            arguments: { path: 'src/a.ts', content: fileWrite.afterContent },
          },
        }),
      )
      .mockResolvedValueOnce('saved');
    GeminiAntigravityProvider.setToolExecutor(
      async (_args: GeminiToolExecutorArgs) => ({ text: 'Wrote src/a.ts.', fileWrite }),
    );
  }

  it('emits an authoritative pre-edit snapshot carrying the content from before the write', async () => {
    mockWriteTurn({
      absPath: '/ws/src/a.ts',
      beforeContent: 'export const a = 1;\n',
      afterContent: 'export const a = 2;\n',
    });

    const chunks = await collect(
      provider.sendMessage('edit it', undefined, 'w1', undefined, '/ws', undefined, WRITE_TOOL),
    );

    const pre = chunks.find((c) => c.type === 'pre_edit_snapshot');
    expect(pre?.preEditSnapshot?.entries).toEqual([
      { path: '/ws/src/a.ts', content: 'export const a = 1;\n', kind: 'update' },
    ]);
    // Authoritative: the content was read inside the write path, so the host
    // must NOT override it with a (staler) FileSnapshotCache lookup.
    expect(pre?.preEditSnapshot?.authoritative).toBe(true);
  });

  it('emits a post-edit snapshot carrying the content the write produced', async () => {
    mockWriteTurn({
      absPath: '/ws/src/a.ts',
      beforeContent: 'export const a = 1;\n',
      afterContent: 'export const a = 2;\n',
    });

    const chunks = await collect(
      provider.sendMessage('edit it', undefined, 'w2', undefined, '/ws', undefined, WRITE_TOOL),
    );

    const post = chunks.find((c) => c.type === 'post_edit_snapshot');
    expect(post?.postEditSnapshot?.entries).toEqual([
      { path: '/ws/src/a.ts', content: 'export const a = 2;\n', kind: 'update' },
    ]);
  });

  it('reports a new file as an add with an empty baseline, not a missing one', async () => {
    // `null` before-content means the file did not exist. An empty-string
    // baseline is the CORRECT answer for a create — the whole file is an
    // addition — and `kind: 'add'` is what stops the host looking for a
    // baseline that was never there.
    mockWriteTurn({
      absPath: '/ws/src/new.ts',
      beforeContent: null,
      afterContent: 'export const b = 1;\n',
    });

    const chunks = await collect(
      provider.sendMessage('create it', undefined, 'w3', undefined, '/ws', undefined, WRITE_TOOL),
    );

    expect(chunks.find((c) => c.type === 'pre_edit_snapshot')?.preEditSnapshot?.entries).toEqual([
      { path: '/ws/src/new.ts', content: '', kind: 'add' },
    ]);
    expect(chunks.find((c) => c.type === 'post_edit_snapshot')?.postEditSnapshot?.entries).toEqual([
      { path: '/ws/src/new.ts', content: 'export const b = 1;\n', kind: 'add' },
    ]);
  });

  it('ties both snapshots to the same toolUseId as the tool call, and emits them before it completes', async () => {
    mockWriteTurn({
      absPath: '/ws/src/a.ts',
      beforeContent: 'old\n',
      afterContent: 'new\n',
    });

    const chunks = await collect(
      provider.sendMessage('edit it', undefined, 'w4', undefined, '/ws', undefined, WRITE_TOOL),
    );

    const announce = chunks.findIndex(
      (c) => c.type === 'tool_call' && c.toolCall?.result === undefined,
    );
    const preIdx = chunks.findIndex((c) => c.type === 'pre_edit_snapshot');
    const postIdx = chunks.findIndex((c) => c.type === 'post_edit_snapshot');
    const resultIdx = chunks.findIndex(
      (c) => c.type === 'tool_call' && c.toolCall?.result !== undefined,
    );

    // Ordering matters: the result chunk closes the attribution window, so a
    // snapshot arriving after it would tag a call the host has stopped
    // associating with this file.
    expect(announce).toBeLessThan(preIdx);
    expect(preIdx).toBeLessThan(postIdx);
    expect(postIdx).toBeLessThan(resultIdx);

    const toolUseId = chunks[announce].toolCall?.id;
    expect(toolUseId).toBeTruthy();
    expect(chunks[preIdx].preEditSnapshot?.toolUseId).toBe(toolUseId);
    expect(chunks[postIdx].postEditSnapshot?.toolUseId).toBe(toolUseId);
  });

  it('emits no snapshots for a tool that wrote nothing', async () => {
    getModelResponse
      .mockResolvedValueOnce(
        JSON.stringify({ tool_call: { name: 'read_file', arguments: { path: 'src/a.ts' } } }),
      )
      .mockResolvedValueOnce('done');
    GeminiAntigravityProvider.setToolExecutor(async () => ({ text: 'contents' }));

    const chunks = await collect(
      provider.sendMessage('read it', undefined, 'r1', undefined, '/ws', undefined, [
        { type: 'function', function: { name: 'read_file' } },
      ]),
    );

    expect(chunks.some((c) => c.type === 'pre_edit_snapshot')).toBe(false);
    expect(chunks.some((c) => c.type === 'post_edit_snapshot')).toBe(false);
  });
});
