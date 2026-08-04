// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Guard against invented CSS custom properties.
 *
 * `var(--nim-does-not-exist)` fails silently: the declaration is dropped and
 * the element inherits instead, so an unreadable button looks fine in a unit
 * test and only shows up when someone opens the app in the other theme. Two
 * separate passes over this component shipped a made-up token
 * (`--nim-primary-subtle`, `--nim-on-primary`), so assert the references
 * resolve.
 */

const componentPath = path.join(__dirname, '..', 'WorkspaceManager.tsx');
const tokenSourcePaths = [
  path.join(__dirname, '..', '..', '..', '..', '..', '..', 'runtime', 'src', 'editor', 'themes', 'NimbalystTheme.css'),
  path.join(__dirname, '..', '..', '..', 'index.css'),
];

function definedTokens(): Set<string> {
  const defined = new Set<string>();
  for (const tokenSourcePath of tokenSourcePaths) {
    if (!fs.existsSync(tokenSourcePath)) continue;
    const css = fs.readFileSync(tokenSourcePath, 'utf8');
    for (const match of css.matchAll(/(--nim-[a-z0-9-]+)\s*:/g)) {
      defined.add(match[1]);
    }
  }
  return defined;
}

describe('WorkspaceManager theme tokens', () => {
  it('finds the canonical token definitions', () => {
    // If this fails the token sources moved and the guard below is vacuous.
    const defined = definedTokens();
    expect(defined.size).toBeGreaterThan(10);
    expect(defined.has('--nim-primary')).toBe(true);
  });

  it('only references --nim-* tokens that are actually defined', () => {
    const defined = definedTokens();
    const source = fs.readFileSync(componentPath, 'utf8');

    const referenced = new Set<string>();
    for (const match of source.matchAll(/var\((--nim-[a-z0-9-]+)/g)) {
      referenced.add(match[1]);
    }

    expect(referenced.size).toBeGreaterThan(0);
    const undefinedTokens = [...referenced].filter((token) => !defined.has(token)).sort();
    expect(undefinedTokens).toEqual([]);
  });
});
