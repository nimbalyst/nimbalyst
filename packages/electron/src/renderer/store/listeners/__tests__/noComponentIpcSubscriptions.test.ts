/**
 * Enforces the centralized-listener rule from docs/IPC_LISTENERS.md.
 *
 * That rule was documentation-only until NIM-2019 / issue #943, where a
 * component-level `session-files:updated` subscription leaked one listener per
 * session switch and a user's renderer crashed after 44 hours of uptime. Nothing
 * failed the build; the rule relied on reviewer attention and lost.
 *
 * `npm run lint` only exists in packages/electron and is not in the pre-push
 * gate, so this guard is a test instead -- test:prepush runs at the repo root
 * and covers packages/runtime too.
 *
 * If this fails: move the subscription into a central listener in
 * store/listeners/ and have the component read an atom. Do NOT add the file to
 * an exemption list -- there is deliberately no exemption list.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../../../../..');

/**
 * Directories where a subscription may live. These either install exactly once
 * at startup, or expose a disposable service whose lifetime the caller owns.
 * See "Sanctioned singleton subscriptions" in docs/IPC_LISTENERS.md.
 */
const SANCTIONED = [
  'packages/electron/src/renderer/store/listeners/',
  'packages/electron/src/renderer/store/atoms/',
  'packages/electron/src/renderer/store/sessionStateListeners.ts',
  'packages/electron/src/renderer/services/',
  'packages/electron/src/renderer/plugins/',
  'packages/electron/src/renderer/extensions/panels/',
  'packages/runtime/src/extensions/',
];

/** Extensions ship their own bundles and use the SDK's panel host, not electronAPI directly. */
const OUT_OF_SCOPE = ['packages/extensions/'];

function findSubscriptionSites(): string[] {
  let output: string;
  try {
    output = execFileSync(
      'git',
      [
        'grep',
        '-l',
        // Untracked files too: a brand-new component with a bad subscription
        // should fail the moment it is written, not once it is staged.
        '--untracked',
        '-E',
        String.raw`electronAPI[?]?\.on\(`,
        '--',
        'packages/electron/src/renderer',
        'packages/runtime/src',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
  } catch (error: any) {
    // git grep exits 1 when there are no matches at all.
    if (error?.status === 1) return [];
    throw error;
  }

  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(file => !file.includes('__tests__'))
    .filter(file => !OUT_OF_SCOPE.some(prefix => file.startsWith(prefix)))
    .filter(file => !SANCTIONED.some(prefix => file.startsWith(prefix)));
}

describe('centralized IPC listener rule', () => {
  it('has no electronAPI.on() outside the sanctioned directories', () => {
    const violations = findSubscriptionSites();

    expect(
      violations,
      'These files subscribe to IPC outside a sanctioned directory. Move the '
        + 'subscription to a central listener in store/listeners/ and read an atom '
        + 'from the component. See docs/IPC_LISTENERS.md.'
    ).toEqual([]);
  });

  it('finds real call sites (guards against the search silently matching nothing)', () => {
    // If the grep breaks, the rule check above passes vacuously forever.
    const output = execFileSync(
      'git',
      ['grep', '-l', '-E', String.raw`electronAPI[?]?\.on\(`, '--', 'packages/electron/src/renderer'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    const files = output.split('\n').filter(Boolean);

    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain('packages/electron/src/renderer/store/listeners/fileStateListeners.ts');
  });
});
