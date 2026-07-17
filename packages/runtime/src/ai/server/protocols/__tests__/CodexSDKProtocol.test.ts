import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { CodexSDKProtocol } from '../CodexSDKProtocol';

function createAsyncEventStream(events: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe('CodexSDKProtocol', () => {
  it('emits a raw_event for every SDK event, including unknown shapes', async () => {
    const sdkEvents = [
      { type: 'unknown.output', payload: { id: 1 } },
      {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'hello from codex',
        },
      },
    ];

    const runStreamed = vi.fn(async () => ({
      events: createAsyncEventStream(sdkEvents),
    }));

    const startThread = vi.fn(() => ({
      id: 'thread-raw-events',
      runStreamed,
    }));

    const protocol = new CodexSDKProtocol(
      'test-key',
      async () =>
        ({
          Codex: class {
            startThread = startThread;
            resumeThread = vi.fn();
          },
        }) as any
    );

    const session = await protocol.createSession({ workspacePath: process.cwd() });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'test' })) {
      emitted.push(event);
    }

    const rawEvents = emitted.filter((event) => event.type === 'raw_event');
    expect(rawEvents).toHaveLength(sdkEvents.length);
    expect(rawEvents[0].metadata?.rawEvent).toEqual(sdkEvents[0]);
    expect(rawEvents[1].metadata?.rawEvent).toEqual(sdkEvents[1]);
    expect(emitted.some((event) => event.type === 'text' && event.content === 'hello from codex')).toBe(true);
  });

  it('captures thread.started IDs without emitting empty text chunks', async () => {
    const runStreamed = vi.fn(async () => ({
      events: createAsyncEventStream([
        { type: 'thread.started', thread_id: 'thread-from-stream' },
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'resumed content',
          },
        },
      ]),
    }));

    const startThread = vi.fn(() => ({
      id: '',
      runStreamed,
    }));

    const protocol = new CodexSDKProtocol(
      'test-key',
      async () =>
        ({
          Codex: class {
            startThread = startThread;
            resumeThread = vi.fn();
          },
        }) as any
    );

    const session = await protocol.createSession({ workspacePath: process.cwd() });
    const emitted: any[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'test' })) {
      emitted.push(event);
    }

    expect(session.id).toBe('thread-from-stream');
    expect(emitted.some((event) => event.type === 'text' && event.content === '')).toBe(false);
  });

  it('forwards raw.additionalDirectories to startThread so the CLI gets --add-dir', async () => {
    const runStreamed = vi.fn(async () => ({
      events: createAsyncEventStream([
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'ok' },
        },
      ]),
    }));

    const startThread = vi.fn((_options?: Record<string, unknown>) => ({
      id: 'thread-add-dir',
      runStreamed,
    }));

    const protocol = new CodexSDKProtocol(
      'test-key',
      async () =>
        ({
          Codex: class {
            startThread = startThread;
            resumeThread = vi.fn();
          },
        }) as any
    );

    await protocol.createSession({
      workspacePath: '/projects/main',
      raw: {
        additionalDirectories: [
          '/projects/main_worktrees/proud-gorge',
          '/projects/main_worktrees/swift-falcon',
          // Filtered: empty / non-string entries should not reach the SDK.
          '',
          undefined as unknown as string,
        ],
      },
    } as any);

    expect(startThread).toHaveBeenCalledTimes(1);
    const passedOptions = startThread.mock.calls[0]![0] as Record<string, unknown>;
    expect(passedOptions.workingDirectory).toBe('/projects/main');
    expect(passedOptions.additionalDirectories).toEqual([
      '/projects/main_worktrees/proud-gorge',
      '/projects/main_worktrees/swift-falcon',
    ]);
  });

  it('omits additionalDirectories when none are supplied', async () => {
    const startThread = vi.fn((_options?: Record<string, unknown>) => ({
      id: 't',
      runStreamed: vi.fn(),
    }));
    const protocol = new CodexSDKProtocol(
      'test-key',
      async () =>
        ({
          Codex: class {
            startThread = startThread;
            resumeThread = vi.fn();
          },
        }) as any
    );

    await protocol.createSession({ workspacePath: '/projects/main' });

    const passedOptions = startThread.mock.calls[0]![0] as Record<string, unknown>;
    expect('additionalDirectories' in passedOptions).toBe(false);
  });

  it('normalizes requested max effort to xhigh in legacy SDK thread options', async () => {
    const startThread = vi.fn((_options?: Record<string, unknown>) => ({
      id: 'thread-max-effort',
      runStreamed: vi.fn(),
    }));
    const protocol = new CodexSDKProtocol(
      'test-key',
      async () =>
        ({
          Codex: class {
            startThread = startThread;
            resumeThread = vi.fn();
          },
        }) as any
    );

    await protocol.createSession({
      workspacePath: '/projects/main',
      raw: { effortLevel: 'max' },
    } as any);

    const passedOptions = startThread.mock.calls[0]![0] as Record<string, unknown>;
    expect(passedOptions.modelReasoningEffort).toBe('xhigh');
    expect(passedOptions).not.toHaveProperty('effortLevel');
  });

  it('forwards a suffixed model string without inferring effort from it', async () => {
    const startThread = vi.fn((_options?: Record<string, unknown>) => ({
      id: 'thread-suffixed-model',
      runStreamed: vi.fn(),
    }));
    const protocol = new CodexSDKProtocol(
      'test-key',
      async () =>
        ({
          Codex: class {
            startThread = startThread;
            resumeThread = vi.fn();
          },
        }) as any
    );

    await protocol.createSession({
      workspacePath: '/projects/main',
      model: 'gpt-5.6-sol-xhigh',
    });

    const passedOptions = startThread.mock.calls[0]![0] as Record<string, unknown>;
    expect(passedOptions.model).toBe('gpt-5.6-sol-xhigh');
    expect(passedOptions.modelReasoningEffort).toBe('high');
  });

  it('passes image attachments as structured local_image inputs', async () => {
    const runStreamed = vi.fn(async () => ({
      events: createAsyncEventStream([
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'described image',
          },
        },
      ]),
    }));

    const startThread = vi.fn(() => ({
      id: 'thread-image-input',
      runStreamed,
    }));

    const protocol = new CodexSDKProtocol(
      'test-key',
      async () =>
        ({
          Codex: class {
            startThread = startThread;
            resumeThread = vi.fn();
          },
        }) as any
    );

    const session = await protocol.createSession({ workspacePath: process.cwd() });

    for await (const _event of protocol.sendMessage(session, {
      content: 'Describe this image',
      attachments: [
        {
          id: 'img-1',
          filename: 'ui.png',
          filepath: '/tmp/ui.png',
          mimeType: 'image/png',
          size: 1234,
          type: 'image',
          addedAt: Date.now(),
        },
      ],
    })) {
      // drain
    }

    expect(runStreamed).toHaveBeenCalledWith([
      { type: 'text', text: 'Describe this image' },
      { type: 'local_image', path: '/tmp/ui.png' },
    ], expect.any(Object));
  });

  it('inlines document attachments as additional text inputs', async () => {
    const tmpFile = path.join(os.tmpdir(), `nimbalyst-codex-sdk-doc-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, 'attached notes', 'utf-8');

    const runStreamed = vi.fn(async () => ({
      events: createAsyncEventStream([
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'processed document',
          },
        },
      ]),
    }));

    const startThread = vi.fn(() => ({
      id: 'thread-document-input',
      runStreamed,
    }));

    const protocol = new CodexSDKProtocol(
      'test-key',
      async () =>
        ({
          Codex: class {
            startThread = startThread;
            resumeThread = vi.fn();
          },
        }) as any
    );

    try {
      const session = await protocol.createSession({ workspacePath: process.cwd() });

      for await (const _event of protocol.sendMessage(session, {
        content: 'Review @notes.txt',
        attachments: [
          {
            id: 'doc-1',
            filename: 'notes.txt',
            filepath: tmpFile,
            mimeType: 'text/plain',
            size: 14,
            type: 'document',
            addedAt: Date.now(),
          },
        ],
      })) {
        // drain
      }

      expect(runStreamed).toHaveBeenCalledWith([
        { type: 'text', text: 'Review @notes.txt' },
        { type: 'text', text: '<file name="notes.txt">\nattached notes\n</file>' },
      ], expect.any(Object));
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });
});
