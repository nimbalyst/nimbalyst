// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseRunConfig, removeTarget, serializeRunConfig, upsertTarget } from '../runConfig';

describe('parseRunConfig', () => {
  it('reads targets and keeps only the documented fields', () => {
    const { targets, errors } = parseRunConfig(
      JSON.stringify({
        targets: [
          {
            id: 'web',
            name: 'Web dev server',
            command: 'pnpm run dev',
            cwd: 'packages/web',
            port: 5173,
            url: 'http://localhost:5173',
            env: { NODE_ENV: 'development' },
            autoStart: true,
          },
          { id: 'worker', name: 'Wrangler', command: 'npx wrangler dev', readyPattern: 'Ready on' },
        ],
      })
    );
    expect(errors).toEqual([]);
    expect(targets).toEqual([
      {
        id: 'web',
        name: 'Web dev server',
        command: 'pnpm run dev',
        cwd: 'packages/web',
        port: 5173,
        url: 'http://localhost:5173',
        env: { NODE_ENV: 'development' },
      },
      { id: 'worker', name: 'Wrangler', command: 'npx wrangler dev', readyPattern: 'Ready on' },
    ]);
  });

  it('reports unparseable JSON without throwing and loads no targets', () => {
    const result = parseRunConfig('{ "targets": [');
    expect(result.targets).toEqual([]);
    expect(result.fatal).toBe(true);
    expect(result.errors[0]).toMatch(/not valid JSON/);
  });

  it('skips a broken target, names what is wrong with it, and still loads the valid ones', () => {
    const { targets, errors } = parseRunConfig(
      JSON.stringify({
        targets: [
          { id: 'ok', name: 'Fine', command: 'node server.js' },
          { id: 'Bad Id', name: 'x', command: 'y' },
          { id: 'no-command', name: 'x' },
          { id: 'port', name: 'x', command: 'y', port: 70000 },
          { id: 'cwd', name: 'x', command: 'y', cwd: '../outside' },
          { id: 'env', name: 'x', command: 'y', env: { PORT: 3000 } },
          { id: 'pattern', name: 'x', command: 'y', readyPattern: '(' },
          { id: 'ok', name: 'Duplicate', command: 'z' },
        ],
      })
    );
    expect(targets.map((t) => t.id)).toEqual(['ok']);
    expect(errors).toHaveLength(7);
    expect(errors.join('\n')).toMatch(/Bad Id/);
    expect(errors.join('\n')).toMatch(/command/);
    expect(errors.join('\n')).toMatch(/port/);
    expect(errors.join('\n')).toMatch(/inside the project/);
    expect(errors.join('\n')).toMatch(/env\.PORT/);
    expect(errors.join('\n')).toMatch(/readyPattern/);
    expect(errors.join('\n')).toMatch(/more than once/);
  });

  it('treats a file without a targets array as an error, not as an empty list', () => {
    const result = parseRunConfig('{"target": []}');
    expect(result.fatal).toBe(true);
  });
});

describe('editing the config', () => {
  const base = JSON.stringify({ $schema: './run.schema.json', targets: [{ id: 'web', name: 'Web', command: 'a' }] });

  it('adds a target, replaces one by id, and keeps unrelated top-level keys', () => {
    const added = upsertTarget(base, { id: 'api', name: 'API', command: 'b', port: 8787 });
    expect(JSON.parse(added)).toEqual({
      $schema: './run.schema.json',
      targets: [
        { id: 'web', name: 'Web', command: 'a' },
        { id: 'api', name: 'API', command: 'b', port: 8787 },
      ],
    });
    const edited = upsertTarget(added, { id: 'web', name: 'Web', command: 'changed' });
    expect(JSON.parse(edited).targets.map((t: { command: string }) => t.command)).toEqual(['changed', 'b']);
  });

  it('renames a target in place when replaceId is given', () => {
    const renamed = upsertTarget(base, { id: 'site', name: 'Site', command: 'a' }, 'web');
    expect(JSON.parse(renamed).targets).toEqual([{ id: 'site', name: 'Site', command: 'a' }]);
  });

  it('refuses to add a target that would not load, and refuses to rewrite a file it cannot parse', () => {
    expect(() => upsertTarget(base, { id: 'x', name: '', command: 'b' })).toThrow(/name/);
    expect(() => upsertTarget('{ broken', { id: 'x', name: 'X', command: 'b' })).toThrow(/not valid JSON/);
    expect(() => removeTarget('{ broken', 'web')).toThrow(/not valid JSON/);
  });

  it('removes a target and reports an unknown id', () => {
    expect(JSON.parse(removeTarget(base, 'web')).targets).toEqual([]);
    expect(() => removeTarget(base, 'nope')).toThrow(/No run target/);
  });

  it('starts a new file when there is none', () => {
    expect(JSON.parse(upsertTarget(null, { id: 'web', name: 'Web', command: 'a' }))).toEqual({
      targets: [{ id: 'web', name: 'Web', command: 'a' }],
    });
    expect(serializeRunConfig({ targets: [] }).endsWith('\n')).toBe(true);
  });
});
