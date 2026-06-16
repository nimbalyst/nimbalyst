/**
 * NIM-806 (input integration) — the single self-runnable round-trip that
 * exercises the genuine `claude-code-cli` input path (image attachments +
 * queued prompts) WITHOUT a real model turn (no billing, no /restart, no UI
 * clicks). Mirrors `claudeCliAskUserQuestionRoundTrip.test.ts`: it drives the
 * REAL pure units (composer, submit, queue flush, user-prompt log) and the REAL
 * runtime transcript projector, injecting only the PTY + DB boundaries.
 *
 * Why these units and not the production singletons: `claudeCliSubmitSingleton`
 * / `claudeCliQueueFlushSingleton` statically import RepositoryManager →
 * electron `app.on`, which crashes a vitest suite. The cores take injected deps
 * specifically so they unit-test without electron / a PTY / a DB.
 *
 * Coverage:
 *   1. Immediate send with an image attachment — PTY gets `<prompt> <path>`
 *      then a separate Enter; the persisted user row carries the CLEAN prompt
 *      (NOT the path-augmented PTY text) + attachment chips in metadata;
 *      analytics flags the attachment.
 *   2. Faithful projection — the captured row projects through the REAL parser
 *      into a user view message that surfaces the typed text AND the attachment
 *      chip.
 *   3. Image-only submission — empty prompt + one attachment still persists a
 *      user row (the turn isn't dropped) and the PTY line is just the path.
 *   4. Queued-prompt flush — the one-per-idle drain chain claims oldest-first,
 *      flushes queued attachments identically to an immediate send, completes
 *      each prompt, and returns false on an empty queue.
 *   5. Flush failure path — a throwing submit marks the prompt failed (not
 *      stuck executing) and flush returns false.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { projectRawMessagesToViewMessages } from '@nimbalyst/runtime/ai/server/transcript';
import type { RawMessage } from '@nimbalyst/runtime/ai/server/transcript';
import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';
import { submitClaudeCliPrompt } from '../claudeCliSubmit';
import { logClaudeCliUserPrompt } from '../claudeCliUserPromptLog';
import { flushNextClaudeCliQueuedPrompt } from '../claudeCliQueueFlush';
import type { FlushQueuedPrompt } from '../claudeCliQueueFlush';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function imageAttachment(filepath: string, id = filepath): ChatAttachment {
  return {
    id,
    filename: filepath.split('/').pop() ?? 'shot.png',
    filepath,
    mimeType: 'image/png',
    size: 1234,
    type: 'image',
    addedAt: 0,
  };
}

interface CapturedRow {
  content: string;
  metadata?: Record<string, unknown>;
}

interface AnalyticsPayload {
  messageLength: number;
  hasAttachments: boolean;
  attachmentCount: number;
  hasDocumentContext: boolean;
}

/**
 * Wire the real units into one submit pipeline used by BOTH immediate-send and
 * queue-flush, injecting only the PTY (writeToTerminal) and DB (createMessage)
 * boundaries. Returns the recording arrays + the composed `submit`.
 */
function makePipeline() {
  const ptyWrites: Array<[string, string]> = [];
  const rows: CapturedRow[] = [];
  const analytics: AnalyticsPayload[] = [];

  const submit = (input: {
    sessionId: string;
    workspacePath: string;
    prompt: string;
    attachments?: ChatAttachment[];
  }) =>
    submitClaudeCliPrompt(input, {
      writeToTerminal: (sid, data) => ptyWrites.push([sid, data]),
      logUserPrompt: (p) =>
        logClaudeCliUserPrompt(p, {
          createMessage: async (row) => {
            rows.push({ content: row.content, metadata: (row as { metadata?: Record<string, unknown> }).metadata });
            return undefined;
          },
          notifyMessageLogged: () => {},
          now: () => new Date('2026-06-08T00:00:00.000Z'),
        }),
      sendAnalytics: (a) => analytics.push(a),
      delay: async () => {},
    });

  return { ptyWrites, rows, analytics, submit };
}

/**
 * Minimal in-memory queued-prompt store matching QueuedPromptStoreLike's
 * relevant subset (listPending / claim / complete / fail). `claim` is atomic:
 * it only returns + marks a prompt if it is still `pending`.
 */
function makeQueueStore(
  seed: Array<{ id: string; prompt?: string | null; attachments?: unknown[] | null }>,
) {
  const items = seed.map((s) => ({
    id: s.id,
    prompt: s.prompt ?? '',
    attachments: s.attachments ?? null,
    status: 'pending' as 'pending' | 'executing' | 'completed' | 'failed',
    errorMessage: undefined as string | undefined,
  }));

  const find = (id: string) => items.find((i) => i.id === id);

  return {
    items,
    listPending: async (_sessionId: string): Promise<FlushQueuedPrompt[]> =>
      items.filter((i) => i.status === 'pending').map((i) => ({ id: i.id, prompt: i.prompt, attachments: i.attachments })),
    claim: async (promptId: string): Promise<FlushQueuedPrompt | null> => {
      const item = find(promptId);
      if (!item || item.status !== 'pending') return null;
      item.status = 'executing';
      return { id: item.id, prompt: item.prompt, attachments: item.attachments };
    },
    complete: async (promptId: string): Promise<void> => {
      const item = find(promptId);
      if (item) item.status = 'completed';
    },
    fail: async (promptId: string, errorMessage: string): Promise<void> => {
      const item = find(promptId);
      if (item) {
        item.status = 'failed';
        item.errorMessage = errorMessage;
      }
    },
  };
}

const SESSION_ID = 's';
const WORKSPACE = '/w';

describe('claude-code-cli input integration round-trip (attachments + queued prompts)', () => {
  let pipe: ReturnType<typeof makePipeline>;

  beforeEach(() => {
    pipe = makePipeline();
  });

  // -------------------------------------------------------------------------
  // 1. Immediate send with an image attachment.
  // -------------------------------------------------------------------------
  it('immediate send: writes prompt+path then Enter, persists the CLEAN prompt + attachment chips, flags analytics', async () => {
    const attachment = imageAttachment('/tmp/shot.png');

    const result = await pipe.submit({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      prompt: 'look at this',
      attachments: [attachment],
    });

    expect(result.submitted).toBe(true);

    // PTY: the composed line (prompt + inline path) then a SEPARATE Enter.
    expect(pipe.ptyWrites).toEqual([
      ['s', 'look at this /tmp/shot.png'],
      ['s', '\r'],
    ]);

    // Exactly one user row, carrying the CLEAN typed prompt (NOT the
    // path-augmented PTY text), with attachment chips in metadata.
    expect(pipe.rows).toHaveLength(1);
    expect(pipe.rows[0].content).toBe(JSON.stringify({ prompt: 'look at this' }));
    expect(pipe.rows[0].metadata).toEqual({ attachments: [attachment] });

    // Analytics: real attachment flags.
    expect(pipe.analytics).toEqual([
      { messageLength: 'look at this'.length, hasAttachments: true, attachmentCount: 1, hasDocumentContext: false },
    ]);
  });

  // -------------------------------------------------------------------------
  // 2. Faithful projection — the captured row renders the attachment chip.
  // -------------------------------------------------------------------------
  it('projection: the persisted row projects into a user message that surfaces the text and the attachment chip', async () => {
    const attachment = imageAttachment('/tmp/shot.png');
    await pipe.submit({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      prompt: 'look at this',
      attachments: [attachment],
    });

    const captured = pipe.rows[0];
    const raw: RawMessage = {
      id: 1,
      sessionId: SESSION_ID,
      source: 'claude-code',
      direction: 'input',
      content: captured.content,
      metadata: captured.metadata,
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
    };

    // 'claude-code-cli' routes (via the default branch of selectRawParser) to
    // the same ClaudeCodeRawParser as 'claude-code', so the chip projects under
    // the provider id the CLI session actually uses.
    const vms = await projectRawMessagesToViewMessages([raw], 'claude-code-cli');
    const userMsg = vms.find((m) => m.type === 'user_message');

    expect(userMsg).toBeDefined();
    expect(userMsg?.text).toBe('look at this');
    expect(userMsg?.attachments).toHaveLength(1);
    expect(userMsg?.attachments?.[0].filepath).toBe('/tmp/shot.png');
  });

  // -------------------------------------------------------------------------
  // 3. Image-only submission — the attachment-only turn isn't dropped.
  // -------------------------------------------------------------------------
  it('image-only: PTY line is just the path and a user row is still persisted', async () => {
    const attachment = imageAttachment('/tmp/only.png');

    const result = await pipe.submit({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      prompt: '',
      attachments: [attachment],
    });

    expect(result.submitted).toBe(true);
    expect(pipe.ptyWrites).toEqual([
      ['s', '/tmp/only.png'],
      ['s', '\r'],
    ]);

    // The turn still produces a user row (empty prompt + attachment chips).
    expect(pipe.rows).toHaveLength(1);
    expect(pipe.rows[0].content).toBe(JSON.stringify({ prompt: '' }));
    expect(pipe.rows[0].metadata).toEqual({ attachments: [attachment] });
  });

  // -------------------------------------------------------------------------
  // 4. Queued-prompt flush — one-per-idle drain chain, attachments flush
  //    identically, drains to empty.
  // -------------------------------------------------------------------------
  it('queue flush: drains oldest-first one prompt per idle, flushing queued attachments identically, then returns false when empty', async () => {
    const a = imageAttachment('/tmp/a.png');
    const store = makeQueueStore([
      { id: 'q1', prompt: 'first', attachments: [a] },
      { id: 'q2', prompt: 'second' },
    ]);

    const deps = {
      listPending: store.listPending,
      claim: store.claim,
      complete: store.complete,
      fail: store.fail,
      submit: pipe.submit,
    };

    // First idle → claims q1 (oldest), writes 'first /tmp/a.png' + Enter.
    const flushed1 = await flushNextClaudeCliQueuedPrompt(
      { sessionId: SESSION_ID, workspacePath: WORKSPACE },
      deps,
    );
    expect(flushed1).toBe(true);
    expect(store.items.find((i) => i.id === 'q1')?.status).toBe('completed');
    expect(pipe.ptyWrites).toEqual([
      ['s', 'first /tmp/a.png'],
      ['s', '\r'],
    ]);
    expect(pipe.rows).toHaveLength(1);
    expect(pipe.rows[0].content).toBe(JSON.stringify({ prompt: 'first' }));
    expect(pipe.rows[0].metadata).toEqual({ attachments: [a] });

    // Second idle → drains q2 ('second', no attachment).
    const flushed2 = await flushNextClaudeCliQueuedPrompt(
      { sessionId: SESSION_ID, workspacePath: WORKSPACE },
      deps,
    );
    expect(flushed2).toBe(true);
    expect(store.items.find((i) => i.id === 'q2')?.status).toBe('completed');
    expect(pipe.ptyWrites.slice(2)).toEqual([
      ['s', 'second'],
      ['s', '\r'],
    ]);
    expect(pipe.rows).toHaveLength(2);
    expect(pipe.rows[1].content).toBe(JSON.stringify({ prompt: 'second' }));
    expect(pipe.rows[1].metadata).toBeUndefined();

    // Third idle → queue empty, no claim, no PTY write.
    const ptyBefore = pipe.ptyWrites.length;
    const flushed3 = await flushNextClaudeCliQueuedPrompt(
      { sessionId: SESSION_ID, workspacePath: WORKSPACE },
      deps,
    );
    expect(flushed3).toBe(false);
    expect(pipe.ptyWrites.length).toBe(ptyBefore);
  });

  // -------------------------------------------------------------------------
  // 5. Flush failure path — a throwing submit marks the prompt failed.
  // -------------------------------------------------------------------------
  it('queue flush failure: a throwing submit marks the prompt failed (not stuck executing) and returns false', async () => {
    const store = makeQueueStore([{ id: 'qx', prompt: 'boom' }]);

    const flushed = await flushNextClaudeCliQueuedPrompt(
      { sessionId: SESSION_ID, workspacePath: WORKSPACE },
      {
        listPending: store.listPending,
        claim: store.claim,
        complete: store.complete,
        fail: store.fail,
        submit: async () => {
          throw new Error('pty exploded');
        },
      },
    );

    expect(flushed).toBe(false);
    const item = store.items.find((i) => i.id === 'qx');
    expect(item?.status).toBe('failed');
    expect(item?.status).not.toBe('executing');
    expect(item?.errorMessage).toBe('pty exploded');
  });
});
