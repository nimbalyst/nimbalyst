import { describe, expect, it } from 'vitest';
import { normalizeProjectPathKey, resolveProjectConfigKey } from '../mcpProjectKey';

describe('normalizeProjectPathKey', () => {
  it('unifies separators', () => {
    expect(normalizeProjectPathKey('C:\\work\\industrylens')).toBe(
      normalizeProjectPathKey('C:/work/industrylens'),
    );
  });

  it('case-folds the drive letter but not the rest of the path', () => {
    expect(normalizeProjectPathKey('c:/work/IndustryLens')).toBe(
      normalizeProjectPathKey('C:/work/IndustryLens'),
    );
    expect(normalizeProjectPathKey('C:/work/industrylens')).not.toBe(
      normalizeProjectPathKey('C:/work/IndustryLens'),
    );
  });

  it('ignores a trailing separator', () => {
    expect(normalizeProjectPathKey('C:/work/inforoot/')).toBe(
      normalizeProjectPathKey('C:/work/inforoot'),
    );
  });
});

describe('resolveProjectConfigKey', () => {
  it('finds a forward-slash key when given a backslash path (#the real bug)', () => {
    // Nimbalyst passes backslashes; Claude Code writes forward slashes. Before
    // this, the exact-string lookup could never hit and every project-scoped
    // server was invisible.
    const projects = {
      'C:/work/industrylens': { mcpServers: { supabase: {} } },
    };
    expect(resolveProjectConfigKey(projects, 'C:\\work\\industrylens')).toBe(
      'C:/work/industrylens',
    );
  });

  it('finds a backslash key when given a forward-slash path', () => {
    const projects = {
      'C:\\rzpl-android\\inforoot.ai': { mcpServers: {} },
    };
    expect(resolveProjectConfigKey(projects, 'C:/rzpl-android/inforoot.ai')).toBe(
      'C:\\rzpl-android\\inforoot.ai',
    );
  });

  it('prefers an exact match over a normalized one', () => {
    // Both forms can exist simultaneously (they do on real machines). An exact
    // hit must win so behaviour does not change for anyone already working.
    const projects = {
      'C:/work/inforoot': { mcpServers: { a: {} } },
      'C:\\work\\inforoot': { mcpServers: { b: {} } },
    };
    expect(resolveProjectConfigKey(projects, 'C:\\work\\inforoot')).toBe('C:\\work\\inforoot');
    expect(resolveProjectConfigKey(projects, 'C:/work/inforoot')).toBe('C:/work/inforoot');
  });

  it('matches a differing drive-letter case', () => {
    const projects = { 'c:/work/locallead': { mcpServers: {} } };
    expect(resolveProjectConfigKey(projects, 'C:\\work\\locallead')).toBe('c:/work/locallead');
  });

  it('picks the populated entry when a duplicate empty key shadows it', () => {
    // Real config seen in the wild: Claude Code wrote the drive letter both ways
    // for the same folder, leaving the servers on one and an empty entry on the
    // other. Picking the empty one would hide every server.
    const projects = {
      'C:/industrylens': {
        mcpServers: { notion: {}, 'n8n-mcp': {}, vercel: {}, industrylens: {} },
      },
      'c:/industrylens': { mcpServers: {} },
    };
    expect(resolveProjectConfigKey(projects, 'C:\\industrylens')).toBe('C:/industrylens');
    // and the same answer whichever spelling the caller happens to pass
    expect(resolveProjectConfigKey(projects, 'c:/industrylens/')).toBe('C:/industrylens');
  });

  it('is deterministic when duplicates are all empty', () => {
    const projects = { 'C:/x': { mcpServers: {} }, 'c:/x': {} };
    const first = resolveProjectConfigKey(projects, 'C:\\x');
    expect(first).toBeDefined();
    expect(resolveProjectConfigKey(projects, 'C:\\x')).toBe(first);
  });

  it('does not match a different project that shares a prefix', () => {
    const projects = { 'C:/work/inforoot': { mcpServers: {} } };
    expect(resolveProjectConfigKey(projects, 'C:/work/inforoot-whatsapp')).toBeUndefined();
  });

  it('returns undefined when there is no match, and tolerates no projects at all', () => {
    expect(resolveProjectConfigKey({ 'C:/other': {} }, 'C:/work/x')).toBeUndefined();
    expect(resolveProjectConfigKey(undefined, 'C:/work/x')).toBeUndefined();
    expect(resolveProjectConfigKey({}, 'C:/work/x')).toBeUndefined();
  });

  it('is separator-agnostic on POSIX paths too', () => {
    const projects = { '/home/dera/work/app': { mcpServers: {} } };
    expect(resolveProjectConfigKey(projects, '/home/dera/work/app/')).toBe(
      '/home/dera/work/app',
    );
  });
});
