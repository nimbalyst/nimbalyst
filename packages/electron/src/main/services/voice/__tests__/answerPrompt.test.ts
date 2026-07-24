import { describe, expect, it, vi, beforeEach } from 'vitest';

// voiceSessionLoader pulls in WindowManager (electron) and the runtime repo;
// MobileSessionControlHandler pulls in the whole AI/electron stack. Stub all
// three so the answer mapping can be tested in node.
const findWindowByWorkspace = vi.fn();
vi.mock('../../../window/WindowManager', () => ({
  findWindowByWorkspace: (...a: any[]) => findWindowByWorkspace(...a),
}));

const list = vi.fn();
vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: { list: (...a: any[]) => list(...a) },
}));

const resolveVoicePromptResponse = vi.fn();
vi.mock('../../ai/MobileSessionControlHandler', () => ({
  resolveVoicePromptResponse: (...a: any[]) => resolveVoicePromptResponse(...a),
}));

import { answerSessionPromptForVoice } from '../answerPrompt';

const WS = '/ws';

/** A fake window whose executeJavaScript resolves ai:loadSession by id. */
function makeWindow(sessionsById: Record<string, any>) {
  return {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: vi.fn(async (code: string) => {
        const match = code.match(/'ai:loadSession',\s*("(?:[^"\\]|\\.)*")/);
        const id = match ? JSON.parse(match[1]) : '';
        return sessionsById[id] ?? null;
      }),
    },
  };
}

function sessionWith(prompt: any) {
  return {
    title: 'Pending session',
    createdAt: Date.now() - 60000,
    messages: [
      { type: 'user_message', text: 'go' },
      { type: 'interactive_prompt', interactivePrompt: prompt },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([]);
});

describe('answerSessionPromptForVoice', () => {
  it('maps a spoken answer to the matching option of a pending question', async () => {
    findWindowByWorkspace.mockReturnValue(
      makeWindow({
        's1': sessionWith({
          promptType: 'ask_user_question',
          status: 'pending',
          requestId: 'req-1',
          questions: [
            { question: 'Default theme?', header: 'Theme', options: [{ label: 'Dark' }, { label: 'Light' }] },
          ],
        }),
      }),
    );

    const out = await answerSessionPromptForVoice(WS, 's1', 'use dark mode');

    expect(out.success).toBe(true);
    expect(resolveVoicePromptResponse).toHaveBeenCalledTimes(1);
    const [sessionId, payload] = resolveVoicePromptResponse.mock.calls[0];
    expect(sessionId).toBe('s1');
    expect(payload).toEqual({
      promptType: 'ask_user_question',
      promptId: 'req-1',
      response: { answers: { Theme: 'Dark' } },
    });
  });

  it('interprets yes/no for a pending permission request', async () => {
    findWindowByWorkspace.mockReturnValue(
      makeWindow({
        's1': sessionWith({
          promptType: 'permission_request',
          status: 'pending',
          requestId: 'req-2',
          toolName: 'Bash',
          rawCommand: 'npm test',
        }),
      }),
    );

    const out = await answerSessionPromptForVoice(WS, 's1', 'yes go ahead');

    expect(out.success).toBe(true);
    const [, payload] = resolveVoicePromptResponse.mock.calls[0];
    expect(payload).toEqual({
      promptType: 'tool_permission',
      promptId: 'req-2',
      response: { decision: 'allow', scope: 'once' },
    });
  });

  it('refuses multi-question prompts (a single spoken answer is ambiguous)', async () => {
    findWindowByWorkspace.mockReturnValue(
      makeWindow({
        's1': sessionWith({
          promptType: 'ask_user_question',
          status: 'pending',
          requestId: 'req-3',
          questions: [
            { question: 'Theme?', header: 'Theme', options: [{ label: 'Dark' }] },
            { question: 'Language?', header: 'Lang', options: [{ label: 'TS' }] },
          ],
        }),
      }),
    );

    const out = await answerSessionPromptForVoice(WS, 's1', 'dark');

    expect(out.success).toBe(false);
    expect(out.error).toMatch(/multiple questions/i);
    expect(resolveVoicePromptResponse).not.toHaveBeenCalled();
  });

  it('reports when there is no pending prompt to answer', async () => {
    findWindowByWorkspace.mockReturnValue(
      makeWindow({
        's1': sessionWith({
          promptType: 'ask_user_question',
          status: 'resolved',
          requestId: 'req-4',
          questions: [{ question: 'Theme?', header: 'Theme' }],
        }),
      }),
    );

    const out = await answerSessionPromptForVoice(WS, 's1', 'dark');

    expect(out.success).toBe(false);
    expect(out.error).toMatch(/not waiting/i);
    expect(resolveVoicePromptResponse).not.toHaveBeenCalled();
  });
});
