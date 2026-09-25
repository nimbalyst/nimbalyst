// @vitest-environment node
/**
 * A model driven by a rendered plain-text transcript does not reliably stop at
 * the end of its own turn. It keeps going and writes our half: a tool result it
 * invented, the next user message, the progress ledger. Everything it invents
 * there is as parseable as the real thing, and the write-directive scan ran on
 * the whole raw response, so invented content reached disk.
 *
 * These cover the truncation that fixes that, and the cases it must NOT eat.
 */
import { describe, expect, it } from 'vitest';
import { AntigravityToolLoopProtocol } from '../AntigravityToolLoopProtocol';
import type { AntigravityServerManager } from '../AntigravityServerManager';

function proto() {
  return new AntigravityToolLoopProtocol({
    modelKey: 'MODEL_X',
    server: {} as unknown as AntigravityServerManager,
  });
}

const REAL_CALL = '{"tool_call":{"name":"run_command","arguments":{"command":"git status"}}}';

describe('a self-authored continuation is cut before parsing', () => {
  it('keeps the real call when an invented write directive follows it', () => {
    // The exact shape observed live: a real run_command, then the model
    // narrating a tool result that never happened, containing a write.
    const response =
      `${REAL_CALL}\n\n` +
      'Tool result (run_command): <tool-output>$ git status\nexit code: 0\n</tool-output>\n\n' +
      'Assistant: Now I will write the file.\n' +
      '<<<WRITE_FILE: src/Imagined.ts>>>\nexport const invented = true;\n<<<END_WRITE_FILE>>>';

    const call = proto().parseToolCall(response);

    expect(call?.name).toBe('run_command');
    expect(call?.arguments.command).toBe('git status');
  });

  it('ignores the loop\'s own nudge template when the model echoes it back', () => {
    // The malformed-directive nudge embeds a COMPLETE directive as an example.
    // Echoed back, it parsed - which is how a file literally named `path`
    // containing `...` appeared in a workspace.
    const response =
      'I could not write that file.\n' +
      'Tool result (write_file): <tool-output>ok</tool-output>\n' +
      '[Your write directive did not parse. Re-emit it in EXACTLY this shape:\n' +
      '<<<WRITE_FILE: relative/path.ext>>>\n<the complete file content, verbatim>\n' +
      '<<<END_WRITE_FILE>>>]';

    expect(proto().parseToolCall(response)).toBeNull();
  });

  it('cuts at the progress ledger, which only the host ever writes', () => {
    // A write DIRECTIVE after the ledger, not another envelope: the envelope
    // scanner already returns the first valid call, so only a directive - which
    // outranks every envelope - can prove the cut is doing the work.
    const response =
      `${REAL_CALL}\n\n` +
      '[Progress: 7/40 tool calls used this turn. You have ALREADY run the calls below]\n' +
      '<<<WRITE_FILE: x.md>>>\nno\n<<<END_WRITE_FILE>>>';

    const call = proto().parseToolCall(response);

    expect(call?.name).toBe('run_command');
  });
});

describe('what truncation must not break', () => {
  it('leaves an ordinary single envelope alone', () => {
    const call = proto().parseToolCall(REAL_CALL);
    expect(call?.name).toBe('run_command');
    expect(call?.arguments.command).toBe('git status');
  });

  it('still accepts a genuine write directive as the whole response', () => {
    const call = proto().parseToolCall(
      '<<<WRITE_FILE: notes/real.md>>>\n# Real\nbody text\n<<<END_WRITE_FILE>>>',
    );
    expect(call?.name).toBe('write_file');
    expect(call?.arguments.path).toBe('notes/real.md');
    // parseWriteFileDirective guarantees a trailing newline on a non-empty body.
    expect(call?.arguments.content).toBe('# Real\nbody text\n');
  });

  it('does not trip on prose that merely mentions the marker words', () => {
    // A real final answer discussed "<tool-output> sanitization tags". Markers
    // are anchored to a newline plus their exact prefix, so prose is safe.
    const response =
      'The loop wraps results in <tool-output> tags and tracks Progress: internally.\n' +
      REAL_CALL;

    const call = proto().parseToolCall(response);
    expect(call?.name).toBe('run_command');
  });
});
