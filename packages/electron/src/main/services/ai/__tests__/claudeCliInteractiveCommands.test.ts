import { describe, it, expect } from 'vitest';
import {
  detectInteractiveCliCommand,
  detectCliPickerInChunk,
  INTERACTIVE_CLI_SLASH_COMMANDS,
} from '../claudeCliInteractiveCommands';

describe('detectInteractiveCliCommand', () => {
  it('matches allowlisted interactive commands (case-insensitive, args ignored)', () => {
    expect(detectInteractiveCliCommand('/model')).toBe('model');
    expect(detectInteractiveCliCommand('  /Model  ')).toBe('model');
    expect(detectInteractiveCliCommand('/model opus')).toBe('model');
    expect(detectInteractiveCliCommand('/terminal-setup')).toBe('terminal-setup');
    expect(detectInteractiveCliCommand('/MCP')).toBe('mcp');
  });

  it('returns null for output-only / non-interactive slash commands', () => {
    expect(detectInteractiveCliCommand('/clear')).toBeNull();
    expect(detectInteractiveCliCommand('/context')).toBeNull();
    expect(detectInteractiveCliCommand('/compact')).toBeNull();
    expect(detectInteractiveCliCommand('/help')).toBeNull();
  });

  it('returns null for normal prompts and non-leading slashes', () => {
    expect(detectInteractiveCliCommand('hello world')).toBeNull();
    expect(detectInteractiveCliCommand('please run /model later')).toBeNull();
    expect(detectInteractiveCliCommand('')).toBeNull();
    expect(detectInteractiveCliCommand(undefined)).toBeNull();
    expect(detectInteractiveCliCommand('/unknown-command')).toBeNull();
  });

  it('keeps the allowlist free of output-only commands', () => {
    for (const banned of ['clear', 'compact', 'cost', 'context', 'help', 'status']) {
      expect(INTERACTIVE_CLI_SLASH_COMMANDS.has(banned)).toBe(false);
    }
  });
});

describe('detectCliPickerInChunk', () => {
  it('detects the Ink selection caret row (after stripping ANSI)', () => {
    expect(detectCliPickerInChunk('\x1b[36m❯ \x1b[39mOpus 4.8 (1M)')).toBe(true);
    expect(detectCliPickerInChunk('  ❯ Sonnet 4.6\r\n    Haiku 4.5')).toBe(true);
  });

  it('ignores normal REPL output without a selection caret', () => {
    expect(detectCliPickerInChunk('> hello')).toBe(false);
    expect(detectCliPickerInChunk('Running tool...\r\n')).toBe(false);
    expect(detectCliPickerInChunk('')).toBe(false);
    expect(detectCliPickerInChunk(undefined)).toBe(false);
  });

  it('does not fire on a lone caret glyph with no menu row', () => {
    expect(detectCliPickerInChunk('❯')).toBe(false);
    expect(detectCliPickerInChunk('❯ ')).toBe(false);
  });
});
