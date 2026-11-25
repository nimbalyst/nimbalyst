// @vitest-environment node
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import type { ChildProcess, spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgySessionManager,
  __resetAgyModelCacheForTests,
  buildAgyEnv,
  contextWindowForAgyModel,
  discoverAgyModels,
  normalizeAgyModelSlug,
  parseAgyModelsOutput,
  prepareAgyAttachments,
} from '../AgyCliHarness';
import { GeminiAntigravityProvider } from '../../GeminiAntigravityProvider';
import { BUILTIN_AGENT_CAPABILITIES } from '../../../agentCapabilities';
import type { ChatAttachment, StreamChunk } from '../../../types';

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  writtenLines: string[] = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.writtenLines.push(chunk.toString('utf8'));
    });
  }

  emitJson(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0, typeof signal === 'string' ? signal : null);
    return true;
  }
}

async function collect<T>(iter: AsyncIterableIterator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe('AgyCliHarness utilities', () => {
  let tmpDir: string;

  beforeEach(() => {
    __resetAgyModelCacheForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-harness-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('parses both tab-separated and multi-space `agy models` output while stripping ANSI', () => {
    const raw = [
      '\x1b[36mFetching available models...\x1b[0m',
      'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
      'gemini-4-neon-high    Gemini 4 Neon (High)',
      'claude-sonnet-4-5\tClaude Sonnet 4.5',
      'gpt-oss-120b   GPT-OSS 120B',
      'gemini-4-neon-high\tDuplicate Should Be Skipped',
    ].join('\n');

    expect(parseAgyModelsOutput(raw)).toEqual([
      { key: 'gemini-4-neon-xhigh', displayName: 'Gemini 4 Neon (XHigh)' },
      { key: 'gemini-4-neon-high', displayName: 'Gemini 4 Neon (High)' },
      { key: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' },
      { key: 'gpt-oss-120b', displayName: 'GPT-OSS 120B' },
    ]);
  });

  it('discovers and caches models via `agy models`', async () => {
    const execFileFn = vi.fn((_bin, _args, _opts, cb) => {
      cb(null, 'gemini-4-neon-high\tGemini 4 Neon (High)\ngemini-4-carbon-high  Gemini 4 Carbon (High)\n', '');
    }) as unknown as typeof import('child_process').execFile;

    const first = await discoverAgyModels(null, null, {
      findBinary: async () => '/fake/agy',
      execFileFn,
    });
    const second = await discoverAgyModels(null, null, {
      findBinary: async () => '/fake/agy',
      execFileFn,
    });

    expect(first).toEqual([
      { key: 'gemini-4-neon-high', displayName: 'Gemini 4 Neon (High)' },
      { key: 'gemini-4-carbon-high', displayName: 'Gemini 4 Carbon (High)' },
    ]);
    expect(second).toEqual(first);
    expect(execFileFn).toHaveBeenCalledTimes(1);
  });

  it('normalizes namespaced IDs and legacy display names to agy slugs', () => {
    expect(normalizeAgyModelSlug('antigravity-gemini-agent:gemini-4-neon-xhigh')).toBe('gemini-4-neon-xhigh');
    expect(normalizeAgyModelSlug('antigravity-gemini-agent:Gemini 4 Neon (High)')).toBe('gemini-4-neon-high');
    expect(normalizeAgyModelSlug(undefined)).toBe('gemini-4-neon-high');
  });

  it('maps model slugs to context windows', () => {
    expect(contextWindowForAgyModel('gemini-4-neon-high')).toBe(1_048_576);
    expect(contextWindowForAgyModel('claude-sonnet-4-5')).toBe(200_000);
    expect(contextWindowForAgyModel('gpt-oss-120b')).toBe(131_072);
  });

  it('strips ELECTRON_RUN_AS_NODE in buildAgyEnv', async () => {
    const prev = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const env = await buildAgyEnv(() => ({ CUSTOM_VAR: 'ok' }), () => '/usr/bin');
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(env.CUSTOM_VAR).toBe('ok');
      expect(env.PATH).toContain(path.join(os.homedir(), '.local', 'bin'));
    } finally {
      if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = prev;
    }
  });

  it('inlines text attachments and emits read_file vision directives + extraDirs for images/PDFs', async () => {
    const txtPath = path.join(tmpDir, 'pasted-text-1.txt');
    const imgPath = path.join(tmpDir, 'shot.png');
    const pdfPath = path.join(tmpDir, 'spec.pdf');
    fs.writeFileSync(txtPath, 'hello pasted text', 'utf8');
    fs.writeFileSync(imgPath, 'fake-png');
    fs.writeFileSync(pdfPath, 'fake-pdf');

    const attachments: ChatAttachment[] = [
      { id: '1', filename: 'pasted-text-1.txt', filepath: txtPath, mimeType: 'text/plain', size: 17, type: 'document', addedAt: 1 },
      { id: '2', filename: 'shot.png', filepath: imgPath, mimeType: 'image/png', size: 8, type: 'image', addedAt: 2 },
      { id: '3', filename: 'spec.pdf', filepath: pdfPath, mimeType: 'application/pdf', size: 8, type: 'pdf', addedAt: 3 },
    ];

    const prepared = await prepareAgyAttachments('check these', attachments);
    expect(prepared.prompt).toContain('[Attached file: pasted-text-1.txt]\nhello pasted text\n[/Attached file]');
    expect(prepared.prompt).toContain(`Call read_file on "${imgPath}"`);
    expect(prepared.prompt).toContain(`Call read_file on "${pdfPath}"`);
    expect(prepared.prompt).toContain('check these');
    expect(prepared.extraDirs).toEqual([tmpDir]);
  });

  it('declares slash-command compaction and context-window reporting for antigravity-gemini-agent', () => {
    expect(BUILTIN_AGENT_CAPABILITIES['antigravity-gemini-agent']).toEqual({
      slashCommands: false,
      skills: false,
      compaction: 'slash-command',
      contextReporting: 'context-window',
    });
  });
});

describe('AgySessionManager & GeminiAntigravityProvider agy harness', () => {
  let tmpDir: string;
  let convMapPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-session-test-'));
    convMapPath = path.join(tmpDir, 'session_map.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('streams text, tool calls, delta usage, context fill, and reuses the warm process across turns', async () => {
    const spawnedArgs: string[][] = [];
    const fakeChild = new FakeChildProcess();
    const spawnFn = vi.fn((_bin: string, args: readonly string[]) => {
      spawnedArgs.push([...args]);
      return fakeChild as unknown as ChildProcess;
    }) as unknown as typeof spawn;

    const manager = new AgySessionManager({
      spawnFn,
      findBinary: async () => '/fake/agy',
      convMapPath,
      userDataDir: tmpDir,
    });

    const provider = new GeminiAntigravityProvider({
      findAgyBinary: async () => '/fake/agy',
      agySessionManager: manager,
    });
    await provider.initialize({ model: 'antigravity-gemini-agent:gemini-4-neon-high' });

    // Turn 1: init + tool ACTIVE/DONE + agent_response text_delta + usage + result
    const turn1Promise = collect<StreamChunk>(
      provider.sendMessage('inspect repo', undefined, 'sess-1', undefined, tmpDir),
    );
    await new Promise((r) => setTimeout(r, 20));
    fakeChild.emitJson({ event: 'init', conversation_id: 'agy-conv-1' });
    fakeChild.emitJson({
      event: 'step_update',
      step_update: {
        step_index: 1,
        step_type: 'tool',
        state: 'ACTIVE',
        tool_info: { name: 'read_file', parameters: { Path: '/a.ts' } },
      },
    });
    fakeChild.emitJson({
      event: 'step_update',
      step_update: {
        step_index: 1,
        step_type: 'tool',
        state: 'DONE',
        tool_info: { name: 'read_file', parameters: { Path: '/a.ts' }, output: 'const x = 1;' },
      },
    });
    fakeChild.emitJson({
      event: 'step_update',
      step_update: { step_type: 'agent_response', text_delta: 'Hello ' },
    });
    fakeChild.emitJson({
      event: 'step_update',
      step_update: {
        step_type: 'agent_response',
        state: 'DONE',
        text_delta: 'world',
        usage: { input_tokens: 1000, cache_read_tokens: 500, output_tokens: 200 },
      },
    });
    fakeChild.emitJson({
      event: 'result',
      result: {
        status: 'SUCCESS',
        conversation_id: 'agy-conv-1',
        response: 'Hello world',
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 500 },
      },
    });

    const turn1 = await turn1Promise;
    expect(spawnedArgs).toHaveLength(1);
    expect(spawnedArgs[0]).toContain('--model');
    expect(spawnedArgs[0]).toContain('gemini-4-neon-high');
    expect(turn1.filter((c) => c.type === 'text').map((c) => c.content).join('')).toBe('Hello world');
    expect(turn1.find((c) => c.type === 'tool_call' && c.toolCall?.result === 'const x = 1;')).toBeTruthy();

    const complete1 = turn1[turn1.length - 1];
    expect(complete1).toMatchObject({
      type: 'complete',
      content: 'Hello world',
      isComplete: true,
      contextFillTokens: 1700,
      contextWindow: 1_048_576,
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        total_tokens: 1200,
        cache_read_input_tokens: 500,
      },
    });

    // Turn 2 on same session + model reuses warm process and computes delta usage + checkpoint compaction
    const turn2Promise = collect<StreamChunk>(
      provider.sendMessage('/compact', undefined, 'sess-1', undefined, tmpDir),
    );
    await new Promise((r) => setTimeout(r, 20));
    fakeChild.emitJson({
      event: 'step_update',
      step_update: { step_type: 'checkpoint', state: 'DONE' },
    });
    fakeChild.emitJson({
      event: 'result',
      result: {
        status: 'SUCCESS',
        conversation_id: 'agy-conv-1',
        usage: { input_tokens: 1400, output_tokens: 250, cache_read_tokens: 800 },
      },
    });

    const turn2 = await turn2Promise;
    expect(spawnedArgs).toHaveLength(1); // still the same warm child
    const complete2 = turn2[turn2.length - 1];
    expect(complete2).toMatchObject({
      type: 'complete',
      content: 'Conversation compacted.',
      contextCompacted: true,
      usage: {
        input_tokens: 400,
        output_tokens: 50,
        total_tokens: 450,
        cache_read_input_tokens: 300,
      },
    });

    // Verify conversation ID was persisted for resume across restarts/model switches
    const persisted = JSON.parse(fs.readFileSync(convMapPath, 'utf8'));
    expect(persisted['sess-1']).toBe('agy-conv-1');

    // Model switch respawns with `--conversation agy-conv-1`
    const secondChild = new FakeChildProcess();
    (spawnFn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_bin: string, args: readonly string[]) => {
        spawnedArgs.push([...args]);
        return secondChild as unknown as ChildProcess;
      },
    );
    await provider.initialize({ model: 'antigravity-gemini-agent:gemini-4-neon-xhigh' });
    const turn3Promise = collect<StreamChunk>(
      provider.sendMessage('continue', undefined, 'sess-1', undefined, tmpDir),
    );
    await new Promise((r) => setTimeout(r, 20));
    secondChild.emitJson({
      event: 'result',
      result: { status: 'SUCCESS', conversation_id: 'agy-conv-1', response: 'resumed ok' },
    });
    const turn3 = await turn3Promise;
    expect(spawnedArgs).toHaveLength(2);
    expect(spawnedArgs[1]).toContain('--conversation');
    expect(spawnedArgs[1]).toContain('agy-conv-1');
    expect(spawnedArgs[1]).toContain('gemini-4-neon-xhigh');
    expect(turn3[turn3.length - 1].content).toBe('resumed ok');

    manager.closeAll();
  });
});
