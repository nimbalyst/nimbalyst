/**
 * `--version` is overloaded: `nim --version` asks the CLI its version, while
 * `nim release finalize --version 0.71.0` names the release being shipped.
 * These pin both readings so adding the release verb can't silently break
 * `nim --version`.
 */
import { describe, it, expect } from 'vitest';
import { parseArgs, flagBool, flagStr } from '../parse.js';

describe('parseArgs --version', () => {
  it('is a boolean when nothing follows it', () => {
    const args = parseArgs(['--version']);
    expect(flagBool(args, 'version')).toBe(true);
  });

  it('is a boolean when only more flags follow it', () => {
    const args = parseArgs(['--version', '--json']);
    expect(flagBool(args, 'version')).toBe(true);
    expect(flagBool(args, 'json')).toBe(true);
  });

  it('takes the value that follows it', () => {
    const args = parseArgs(['release', 'finalize', '--version', '0.71.0']);
    expect(flagStr(args, 'version')).toBe('0.71.0');
    expect(flagBool(args, 'version')).toBe(false);
    expect(args.noun).toBe('release');
    expect(args.verb).toBe('finalize');
  });

  it('takes an inline value', () => {
    expect(flagStr(parseArgs(['release', 'finalize', '--version=1.2.3']), 'version')).toBe('1.2.3');
  });

  it('does not swallow the next positional as a version', () => {
    const args = parseArgs(['release', 'finalize', 'NIM-1', '--version', '1.0.0']);
    expect(args.positionals).toEqual(['NIM-1']);
    expect(flagStr(args, 'version')).toBe('1.0.0');
  });
});
