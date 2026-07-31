import { describe, expect, it, vi } from 'vitest';
import {
  buildClaudeCliEffortSwitchCommand,
  switchClaudeCliEffort,
} from '../claudeCliEffortSwitch';

describe('buildClaudeCliEffortSwitchCommand', () => {
  it('builds the slash command for every valid level', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(buildClaudeCliEffortSwitchCommand(level)).toBe(`/effort ${level}`);
    }
  });

  it('refuses anything that is not a known level', () => {
    // Never type an unvalidated string into a live PTY.
    expect(buildClaudeCliEffortSwitchCommand('')).toBeNull();
    expect(buildClaudeCliEffortSwitchCommand(undefined)).toBeNull();
    expect(buildClaudeCliEffortSwitchCommand('ludicrous')).toBeNull();
    expect(buildClaudeCliEffortSwitchCommand('high; rm -rf /')).toBeNull();
  });
});

describe('switchClaudeCliEffort', () => {
  it('writes the command and Enter as two separate writes', () => {
    // A single `text + \r` write can leave the Ink TUI showing the text without
    // consuming Enter, which is the same reason the model switch is two-step.
    const writeToTerminal = vi.fn();
    const delay = vi.fn(async () => {});

    return switchClaudeCliEffort({ sessionId: 's1', effortLevel: 'high' }, {
      writeToTerminal,
      delay,
    }).then((result) => {
      expect(result).toEqual({ switched: true, level: 'high' });
      expect(writeToTerminal).toHaveBeenNthCalledWith(1, 's1', '/effort high');
      expect(writeToTerminal).toHaveBeenNthCalledWith(2, 's1', '\r');
      expect(delay).toHaveBeenCalledOnce();
    });
  });

  it('writes nothing at all for an invalid level', async () => {
    const writeToTerminal = vi.fn();
    const result = await switchClaudeCliEffort(
      { sessionId: 's1', effortLevel: 'nonsense' },
      { writeToTerminal, delay: async () => {} },
    );
    expect(result).toEqual({ switched: false });
    expect(writeToTerminal).not.toHaveBeenCalled();
  });
});
