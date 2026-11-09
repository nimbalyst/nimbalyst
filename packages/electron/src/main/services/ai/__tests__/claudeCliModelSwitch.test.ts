import { describe, it, expect, vi } from 'vitest';
import {
  buildClaudeCliModelSwitchCommand,
  switchClaudeCliModel,
  MODEL_SWITCH_WRITE_GAP_MS,
} from '../claudeCliModelSwitch';

/**
 * NIM-806 — mid-session model switching for claude-code-cli sessions.
 *
 * The genuine CLI supports `/model <value>` as a direct setter, so the picker
 * can retune a RUNNING session by typing the command into the PTY (text first,
 * then a separate Enter after a gap — the same two-write shape as
 * claudeCliSubmit, since a single `text + \r` write can leave the Ink TUI
 * showing the text without consuming Enter). Values reuse
 * resolveClaudeCliModelArg so the picker's combined ids map to the CLI's own
 * aliases (`fable`, `claude-opus-5-5[1m]`, ...).
 */
describe('buildClaudeCliModelSwitchCommand', () => {
  it('maps the fable combined id to /model fable', () => {
    expect(buildClaudeCliModelSwitchCommand('claude-code-cli:fable')).toBe('/model claude-fable-5-2');
  });

  it('maps fable-1m to the CLI 1M form', () => {
    expect(buildClaudeCliModelSwitchCommand('claude-code-cli:fable-1m')).toBe('/model claude-fable-5-2[1m]');
  });

  it('maps opus-1m to the CLI 1M alias', () => {
    expect(buildClaudeCliModelSwitchCommand('claude-code-cli:opus-1m')).toBe('/model claude-opus-5-5[1m]');
  });

  it('keeps pinned opus versions when switching', () => {
    expect(buildClaudeCliModelSwitchCommand('claude-code-cli:opus-4-7')).toBe('/model claude-opus-4-7');
  });

  it('rejects non-claude combined ids', () => {
    expect(buildClaudeCliModelSwitchCommand('openai:gpt-5.5')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(buildClaudeCliModelSwitchCommand(undefined)).toBeNull();
    expect(buildClaudeCliModelSwitchCommand('   ')).toBeNull();
  });
});

describe('switchClaudeCliModel', () => {
  function makeDeps() {
    const writes: string[] = [];
    return {
      writes,
      deps: {
        writeToTerminal: vi.fn((_sessionId: string, data: string) => {
          writes.push(data);
        }),
        delay: vi.fn(async (_ms: number) => {}),
      },
    };
  }

  it('writes the /model command then a separate Enter after the gap', async () => {
    const { writes, deps } = makeDeps();
    const result = await switchClaudeCliModel(
      { sessionId: 's1', model: 'claude-code-cli:fable' },
      deps,
    );
    expect(result).toEqual({ switched: true, cliArg: 'claude-fable-5-2' });
    expect(writes).toEqual(['/model claude-fable-5-2', '\r']);
    expect(deps.delay).toHaveBeenCalledWith(MODEL_SWITCH_WRITE_GAP_MS);
  });

  it('confirms the switch when the CLI asks instead of leaving it pending', async () => {
    // CLI 2.1.225 stopped treating `/model x` as a direct setter: on a cached
    // conversation it opens "Switch model?" with Yes/No and WAITS. Nothing
    // answered it, so the session sat in progress and the only way through was
    // the raw terminal. The model was already chosen in Nimbalyst's picker, so
    // the dialog re-asks a question the user has answered.
    const { writes, deps } = makeDeps();
    const result = await switchClaudeCliModel(
      { sessionId: 's1', model: 'claude-code-cli:opus-1m' },
      {
        ...deps,
        readRecentOutput: () =>
          'Switch model?\n  1. Yes, switch to Opus 5 (1M context)\n  2. No, go back',
      },
    );
    expect(result).toEqual({ switched: true, cliArg: 'claude-opus-5-5[1m]', confirmed: true });
    // command, Enter, then the confirmation Enter accepting the highlighted Yes
    expect(writes).toEqual(['/model claude-opus-5-5[1m]', '\r', '\r']);
  });

  it('does not send a confirmation Enter when no dialog appeared', async () => {
    const { writes, deps } = makeDeps();
    await switchClaudeCliModel(
      { sessionId: 's1', model: 'claude-code-cli:fable' },
      { ...deps, readRecentOutput: () => 'ordinary output, no dialog' },
    );
    expect(writes).toEqual(['/model claude-fable-5-2', '\r']);
  });

  it('does not touch the PTY for an unresolvable model', async () => {
    const { writes, deps } = makeDeps();
    const result = await switchClaudeCliModel({ sessionId: 's1', model: 'openai:gpt-5.5' }, deps);
    expect(result).toEqual({ switched: false });
    expect(writes).toEqual([]);
  });
});
