// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentProtocol, ProtocolSession } from '../../protocols/ProtocolInterface';
import type { GrokACPProtocol } from '../../protocols/GrokACPProtocol';
import { BaseAgentProvider } from '../BaseAgentProvider';
import { GrokBuildProvider } from '../GrokBuildProvider';
import { CursorAgentProvider } from '../CursorAgentProvider';
import { CURSOR_INLINE_DOCUMENT_BUDGET, CursorAgentProtocol } from '../../protocols/CursorAgentProtocol';

function protocolWithDelivery(
  deliveredMcpServerCount?: number,
  appliedModel?: string,
): GrokACPProtocol {
  const session = (): ProtocolSession => ({
    id: 'grok-session',
    platform: 'test',
    ...(deliveredMcpServerCount === undefined ? {} : { deliveredMcpServerCount }),
    ...(appliedModel === undefined ? {} : { appliedModel }),
  });
  const protocol: AgentProtocol = {
    platform: 'test',
    createSession: vi.fn(async () => session()),
    resumeSession: vi.fn(async () => session()),
    forkSession: vi.fn(async () => session()),
    async *sendMessage() {
      yield { type: 'complete' as const };
    },
    abortSession: vi.fn(),
    cleanupSession: vi.fn(),
  };
  return {
    ...protocol,
    setGrokPath: vi.fn(),
    setProcessEnv: vi.fn(),
    setAskUserQuestionHandler: vi.fn(),
  } as unknown as GrokACPProtocol;
}

async function runProvider(protocol: GrokACPProtocol): Promise<GrokBuildProvider> {
  BaseAgentProvider.setTrustChecker(() => ({ trusted: true, mode: 'allow-all' }));
  GrokBuildProvider.setMCPConfigLoader(async () => ({
    stdio: { command: 'node', args: ['server.js'] },
    remote: { type: 'http', url: 'http://127.0.0.1:41001/mcp' },
  }));
  GrokBuildProvider.setGrokPathLoader(() => '/usr/bin/true');
  const provider = new GrokBuildProvider({ protocol });
  await provider.initialize({ model: 'grok-build:grok-4.6' });
  const chunks = [];
  for await (const chunk of provider.sendMessage('hello', undefined, undefined, undefined, '/tmp')) chunks.push(chunk);
  if (!provider.getInitData()) throw new Error(`Provider did not initialize: ${JSON.stringify(chunks)}`);
  return provider;
}

afterEach(() => {
  CursorAgentProvider.setCursorPathLoader(null);
  BaseAgentProvider.setTrustChecker(null);
  GrokBuildProvider.setMCPConfigLoader(null);
  GrokBuildProvider.setGrokPathLoader(null);
  GrokBuildProvider.setShellEnvironmentLoader(null);
  GrokBuildProvider.setEnhancedPathLoader(null);
});

describe.each(['create-chat', 'turn'])('Cursor spawn failures during %s', (stage) => {
  it.each([
    ['E2BIG', 'spawn E2BIG', /prompt.*too large/i],
    ['E2BIG', 'Argument list exceeds operating system limit', /prompt.*too large/i],
    ['ENOENT', 'spawn ENOENT', /not installed|not found/i],
    ['ENAMETOOLONG', 'spawn ENAMETOOLONG', /prompt.*too large/i],
    ['EACCES', 'spawn EACCES', /found.*not executable/i],
    ['EPERM', 'spawn EPERM', /found.*not executable/i],
  ] as const)('classifies %s (%s)', async (code, message, expected) => {
    BaseAgentProvider.setTrustChecker(() => ({ trusted: true, mode: 'allow-all' }));
    CursorAgentProvider.setCursorPathLoader(() => process.execPath);
    const error = Object.assign(new Error(message), { code });
    const protocol = new CursorAgentProtocol({
      createChat: async () => { if (stage === 'create-chat') throw error; return 'cursor-session'; },
      runNdjson: async function* () { throw error; },
    });
    const provider = new CursorAgentProvider({ protocol });
    await provider.initialize({ model: 'cursor-agent:auto' });
    const chunks = [];
    for await (const chunk of provider.sendMessage('hello', undefined, undefined, undefined, process.cwd())) chunks.push(chunk);
    const failures = chunks.filter((chunk) => chunk.type === 'error');
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatch(expected);
    if (code === 'EACCES' || code === 'EPERM') expect(failures[0].error).toContain(process.execPath);
  });
});

it.each(['- fix the bug', '--plan'])('passes %j as prompt text after the option terminator', async (content) => {
  let args: string[] = [];
  const protocol = new CursorAgentProtocol({
    runNdjson: async function* (options) {
      args = options.args;
      yield { kind: 'record', value: { type: 'result', subtype: 'success', result: 'done' } };
    },
  });
  const session = await protocol.resumeSession('cursor-session', { workspacePath: process.cwd(), model: 'cursor-agent:auto' });
  for await (const _event of protocol.sendMessage(session, { content })) { /* drain */ }
  expect(args.slice(-2)).toEqual(['--', content]);
  expect(args.slice(0, -2)).toEqual(['--resume', 'cursor-session', '-p', '--output-format', 'stream-json', '--model', 'auto', '--force', '--trust']);
});

it('hands attachments to the Cursor CLI through the prompt, which has no file input flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-attachments-'));
  try {
    const shotPath = join(dir, 'shot.png');
    const notesPath = join(dir, 'notes.md');
    const logPath = join(dir, 'big.log');
    writeFileSync(shotPath, 'png bytes');
    writeFileSync(notesPath, 'release checklist body');
    writeFileSync(logPath, 'x'.repeat(CURSOR_INLINE_DOCUMENT_BUDGET));
    let args: string[] = [];
    const protocol = new CursorAgentProtocol({
      runNdjson: async function* (options) {
        args = options.args;
        yield { kind: 'record', value: { type: 'result', subtype: 'success', result: 'done' } };
      },
    });
    const session = await protocol.resumeSession('cursor-session', { workspacePath: process.cwd() });
    const attachment = { id: 'a', mimeType: '', size: 1, addedAt: 0 };
    for await (const _event of protocol.sendMessage(session, {
      content: 'what is in @shot.png?',
      attachments: [
        { ...attachment, type: 'image', filename: 'shot.png', filepath: shotPath },
        { ...attachment, type: 'document', filename: 'notes.md', filepath: notesPath },
        { ...attachment, type: 'document', filename: 'big.log', filepath: logPath },
        { ...attachment, type: 'pdf', filename: 'gone.pdf', filepath: join(dir, 'gone.pdf') },
      ],
    })) { /* drain */ }
    const prompt = args[args.length - 1];
    expect(prompt.startsWith('what is in @shot.png?')).toBe(true);
    expect(prompt).toContain(`- shot.png: ${shotPath}`);
    expect(prompt).toContain('<file name="notes.md">\nrelease checklist body\n</file>');
    // Over the argv budget: referenced by path, never inlined.
    expect(prompt).toContain(`- big.log: ${logPath}`);
    expect(prompt.length).toBeLessThan(CURSOR_INLINE_DOCUMENT_BUDGET);
    // A staged file that is gone is explained, not handed over as a dead path.
    expect(prompt).toMatch(/<file name="gone\.pdf" error="failed to read attachment: [^"]*ENOENT/);
    expect(prompt).not.toContain('- gone.pdf:');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('HeadlessCliAgentProvider MCP delivery count', () => {
  it('reports the count supplied by a delivering protocol', async () => {
    const provider = await runProvider(protocolWithDelivery(2));
    expect(provider.getInitData()?.mcpServerCount).toBe(2);
  });

  it('reports zero when a protocol does not declare any delivered servers', async () => {
    const provider = await runProvider(protocolWithDelivery());
    expect(provider.getInitData()?.mcpServerCount).toBe(0);
  });

  it('reports the model the protocol applied, not the one that was requested', async () => {
    // The turn is configured for grok-4.6 but the protocol reports grok-4.5 as
    // live. Reporting a model the agent did not run is worse than not offering
    // the choice, so the protocol's observation wins.
    const provider = await runProvider(protocolWithDelivery(0, 'grok-4.5'));
    expect(provider.getInitData()?.model).toBe('grok-4.5');
  });

  it('falls back to the requested model when the protocol cannot observe one', async () => {
    const provider = await runProvider(protocolWithDelivery(0));
    expect(provider.getInitData()?.model).toBe('grok-build:grok-4.6');
  });
});
