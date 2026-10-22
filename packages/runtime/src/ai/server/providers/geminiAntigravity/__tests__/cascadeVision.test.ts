// @vitest-environment node
/**
 * Attachment understanding for the Gemini (Antigravity) provider.
 *
 * Two layers:
 *   - runCascadeVision against a fake server: the exact RPC sequence and
 *     payload shape measured against Antigravity 2.24.0.
 *   - provider.sendMessage with only the server's RPC surface mocked: images
 *     (attached or @-mentioned) are shown to the model before the tool loop,
 *     the analysis reaches the loop prompt, and later turns keep it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildVisionPrompt,
  extractCascadeAnswer,
  isCascadeVisionMime,
  runCascadeVision,
  type CascadeVisionServer,
} from '../AntigravityCascadeVision';
import { GeminiAntigravityProvider, mentionedMediaPaths } from '../../GeminiAntigravityProvider';
import { AntigravityServerManager } from '../AntigravityServerManager';
import type { ChatAttachment, StreamChunk } from '../../../types';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function trajectory(answer: string, status = 'CASCADE_RUN_STATUS_IDLE') {
  return {
    status,
    trajectory: {
      steps: [
        { type: 'CORTEX_STEP_TYPE_USER_INPUT' },
        { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: answer } },
      ],
    },
  };
}

function fakeServer(answer = 'A red square.') {
  const calls: Array<{ method: string; body: any }> = [];
  const server: CascadeVisionServer = {
    resolveModelEnum: vi.fn(async () => 'MODEL_PLACEHOLDER_M319'),
    callRpc: vi.fn(async (method: string, body: unknown) => {
      calls.push({ method, body });
      if (method === 'StartCascade') return { cascadeId: 'c-1' } as never;
      if (method === 'GetCascadeTrajectory') return trajectory(answer) as never;
      return {} as never;
    }),
  };
  return { server, calls };
}

describe('runCascadeVision', () => {
  it('sends the attachment as media (not the ignored images field) on the session model and returns the answer', async () => {
    const { server, calls } = fakeServer('Left half red, right half blue.');
    const answer = await runCascadeVision(server, {
      userMessage: 'what colours?',
      inputs: [{ name: 'shot.png', mimeType: 'image/png', data: PNG }],
      modelKey: 'gemini-3.8-flash-medium',
    });

    expect(answer).toBe('Left half red, right half blue.');
    expect(server.resolveModelEnum).toHaveBeenCalledWith('gemini-3.8-flash-medium');
    expect(calls.map((c) => c.method)).toEqual([
      'StartCascade', 'SendUserCascadeMessage', 'GetCascadeTrajectory', 'DeleteCascadeTrajectory',
    ]);
    expect(calls[0].body).toMatchObject({
      source: 'CORTEX_TRAJECTORY_SOURCE_SDK',
      requestedModel: 'MODEL_PLACEHOLDER_M319',
    });
    const send = calls[1].body;
    expect(send.cascadeId).toBe('c-1');
    expect(send.images).toBeUndefined();
    expect(send.media).toEqual([{ mimeType: 'image/png', inlineData: PNG.toString('base64'), displayName: 'shot.png' }]);
    expect(send.cascadeConfig.plannerConfig.requestedModel).toEqual({ model: 'MODEL_PLACEHOLDER_M319' });
    expect(send.items[0].text).toContain('what colours?');
    expect(send.items[0].text).toContain('Do not use any tools');
    expect(calls[3].body).toEqual({ cascadeId: 'c-1' });
  });

  it('polls while the cascade is still running', async () => {
    let polls = 0;
    const server: CascadeVisionServer = {
      resolveModelEnum: vi.fn(async () => 'MODEL_X'),
      callRpc: vi.fn(async (method: string) => {
        if (method === 'StartCascade') return { cascadeId: 'c-2' } as never;
        if (method === 'GetCascadeTrajectory') {
          polls++;
          return (polls < 2 ? trajectory('', 'CASCADE_RUN_STATUS_RUNNING') : trajectory('done')) as never;
        }
        return {} as never;
      }),
    };
    await expect(runCascadeVision(server, {
      userMessage: '', inputs: [{ name: 'a.png', mimeType: 'image/png', data: PNG }], modelKey: 'k', pollMs: 1,
    })).resolves.toBe('done');
    expect(polls).toBe(2);
  });

  it('throws on an empty answer and still deletes the trajectory', async () => {
    const { server, calls } = fakeServer('');
    await expect(runCascadeVision(server, {
      userMessage: 'x', inputs: [{ name: 'a.png', mimeType: 'image/png', data: PNG }], modelKey: 'MODEL_Y',
    })).rejects.toThrow(/no analysis/);
    expect(server.resolveModelEnum).not.toHaveBeenCalled();
    expect(calls.at(-1)?.method).toBe('DeleteCascadeTrajectory');
  });

  it('helpers: mime filter, prompt, answer extraction', () => {
    expect(isCascadeVisionMime('image/png')).toBe(true);
    expect(isCascadeVisionMime('application/pdf')).toBe(true);
    expect(isCascadeVisionMime('text/plain')).toBe(false);
    expect(buildVisionPrompt('', ['a.png'])).toContain('no text');
    expect(extractCascadeAnswer({ trajectory: { steps: [
      { plannerResponse: { response: 'first' } },
      { plannerResponse: { response: 'raw', modifiedResponse: 'final' } },
    ] } })).toBe('final');
    expect(extractCascadeAnswer(null)).toBe('');
  });

  it('finds @-mentioned image and PDF paths only', () => {
    expect(mentionedMediaPaths('see @docs/a.png, and @"my dir/b.JPG" plus @src/x.ts or @c.pdf.'))
      .toEqual(['docs/a.png', 'my dir/b.JPG', 'c.pdf']);
  });
});

async function collect(stream: AsyncIterableIterator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('GeminiAntigravityProvider attachments', () => {
  let getModelResponse: import('vitest').MockInstance<AntigravityServerManager['getModelResponse']>;
  let callRpc: import('vitest').MockInstance<AntigravityServerManager['callRpc']>;
  let provider: GeminiAntigravityProvider;
  let workspace: string;
  let visionAnswer: string | Error;

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-vision-'));
    fs.mkdirSync(path.join(workspace, 'assets'));
    fs.writeFileSync(path.join(workspace, 'assets', 'icon.png'), PNG);
    visionAnswer = 'Navy square with an orange block.';
    getModelResponse = vi.spyOn(AntigravityServerManager.prototype, 'getModelResponse')
      .mockResolvedValue('It is a navy icon.');
    vi.spyOn(AntigravityServerManager.prototype, 'resolveModelEnum').mockResolvedValue('MODEL_PLACEHOLDER_M319');
    callRpc = vi.spyOn(AntigravityServerManager.prototype, 'callRpc').mockImplementation(async (method: string) => {
      if (method === 'StartCascade') return { cascadeId: 'c-9' } as never;
      if (method === 'GetCascadeTrajectory') {
        if (visionAnswer instanceof Error) throw visionAnswer;
        return trajectory(visionAnswer) as never;
      }
      return {} as never;
    });
    provider = new GeminiAntigravityProvider();
    await provider.initialize({ model: 'gemini-3.8-flash-medium' });
  });

  afterEach(() => {
    provider.destroy();
    vi.restoreAllMocks();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const sentMedia = () => callRpc.mock.calls
    .filter(([m]) => m === 'SendUserCascadeMessage')
    .map(([, body]) => (body as { media: Array<{ displayName: string }> }).media.map((m) => m.displayName));

  it('shows an attached image to the model before the tool loop and answers from the analysis', async () => {
    const attachment: ChatAttachment = {
      id: 'a1', filename: 'icon.png', filepath: path.join(workspace, 'assets', 'icon.png'),
      mimeType: 'image/png', size: PNG.length, type: 'image', addedAt: 0,
    };
    const chunks = await collect(provider.sendMessage('what is this?', undefined, 's-att', undefined, workspace, [attachment]));

    expect(sentMedia()).toEqual([['icon.png']]);
    const card = chunks.find((c) => c.type === 'tool_call' && c.toolCall?.name === 'view_attachments' && c.toolCall.result);
    expect(card?.toolCall?.result).toBe('Navy square with an orange block.');
    expect(getModelResponse.mock.calls[0][0]).toContain('Navy square with an orange block.');
    expect(chunks.at(-1)?.type).toBe('complete');
  });

  it('treats an @-mentioned workspace image like an attachment, and keeps the analysis for later turns', async () => {
    await collect(provider.sendMessage('can you see @assets/icon.png ?', undefined, 's-men', undefined, workspace));
    expect(sentMedia()).toEqual([['assets/icon.png']]);

    getModelResponse.mockClear();
    await collect(provider.sendMessage('now describe its colours again', undefined, 's-men', undefined, workspace));
    expect(sentMedia()).toHaveLength(1); // no second look
    expect(getModelResponse.mock.calls[0][0]).toContain('Navy square with an orange block.');
  });

  it('ignores mentions that are not files and skips paths outside the project', async () => {
    const outside = path.join(os.tmpdir(), `agy-outside-${Date.now()}.png`);
    fs.writeFileSync(outside, PNG);
    try {
      const chunks = await collect(provider.sendMessage(`compare @nope.png with @../${path.basename(outside)}`, undefined, 's-skip', undefined, workspace));
      expect(sentMedia()).toEqual([]);
      const card = chunks.find((c) => c.type === 'tool_call' && c.toolCall?.result);
      expect(card?.toolCall?.arguments).toMatchObject({ files: [], skipped: [expect.stringContaining('outside the project')] });
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('tells the model the image could not be shown instead of failing the turn', async () => {
    visionAnswer = new Error('HTTP 500');
    const chunks = await collect(provider.sendMessage('look at @assets/icon.png', undefined, 's-err', undefined, workspace));
    const card = chunks.find((c) => c.type === 'tool_call' && c.toolCall?.result);
    expect(card?.toolCall?.result).toContain('Could not show assets/icon.png');
    expect(getModelResponse.mock.calls[0][0]).toContain('could not be shown to you');
    expect(chunks.at(-1)?.type).toBe('complete');
  });

  it('does nothing extra for a plain text turn', async () => {
    await collect(provider.sendMessage('hello', undefined, 's-plain', undefined, workspace));
    expect(callRpc).not.toHaveBeenCalled();
  });
});
