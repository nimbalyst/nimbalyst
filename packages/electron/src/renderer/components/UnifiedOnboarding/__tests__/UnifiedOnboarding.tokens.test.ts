// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const componentPath = path.join(__dirname, '..', 'UnifiedOnboarding.css');
const tokenSourcePath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'runtime',
  'src',
  'editor',
  'themes',
  'NimbalystTheme.css',
);

describe('UnifiedOnboarding theme tokens', () => {
  it('only references canonical --nim-* tokens', () => {
    const tokenSource = fs.readFileSync(tokenSourcePath, 'utf8');
    const componentSource = fs.readFileSync(componentPath, 'utf8');
    const defined = new Set(
      [...tokenSource.matchAll(/(--nim-[a-z0-9-]+)\s*:/g)].map((match) => match[1]),
    );
    const referenced = new Set(
      [...componentSource.matchAll(/var\((--nim-[a-z0-9-]+)/g)].map((match) => match[1]),
    );

    expect(defined.size).toBeGreaterThan(10);
    expect([...referenced].filter((token) => !defined.has(token)).sort()).toEqual([]);
  });
});
