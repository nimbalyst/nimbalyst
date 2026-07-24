/**
 * Phase 7.6 integration test.
 *
 * Validates the API surface that lets Nimbalyst extensions contribute
 * `LexicalExtension` instances to the host editor:
 *
 * - The runtime store accepts an array of opaque extension values and
 *   notifies subscribers. The editor reads through this store rather than
 *   the platform-specific loader, keeping the editor decoupled.
 *
 * - `buildEditorFromExtensions` accepts the contributed extensions as
 *   dependencies and the contributed `register(...)` hook runs against
 *   the live editor instance. This is the path that lets a third-party
 *   extension ship a Lexical plugin end-to-end.
 *
 * - `configExtension` overrides applied at the contribution boundary are
 *   respected by the `register` hook -- a third-party extension can pass
 *   per-instance configuration via the same API.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildEditorFromExtensions,
  configExtension,
  defineExtension,
} from '@lexical/extension';
import type { LexicalEditor } from 'lexical';

import {
  getExtensionLexicalExtensions,
  setExtensionLexicalExtensions,
  subscribeToExtensionLexicalExtensions,
} from '../extensionLexicalExtensionsStore';

describe('extensionLexicalExtensionsStore (Phase 7.6 API)', () => {
  beforeEach(() => {
    // Reset shared module-level state between tests so they cannot
    // observe each other's publications.
    setExtensionLexicalExtensions([]);
  });

  it('starts empty', () => {
    expect(getExtensionLexicalExtensions()).toEqual([]);
  });

  it('publishes contributed extensions and notifies subscribers', () => {
    const probe = defineExtension({ name: 'test/probe' });
    let notifyCount = 0;
    const unsubscribe = subscribeToExtensionLexicalExtensions(() => {
      notifyCount += 1;
    });

    setExtensionLexicalExtensions([probe]);
    expect(getExtensionLexicalExtensions()).toEqual([probe]);
    expect(notifyCount).toBe(1);

    setExtensionLexicalExtensions([]);
    expect(getExtensionLexicalExtensions()).toEqual([]);
    expect(notifyCount).toBe(2);

    unsubscribe();
    setExtensionLexicalExtensions([probe]);
    expect(notifyCount).toBe(2);
  });

  it('does not re-emit when the same array reference is published twice', () => {
    const arr = [defineExtension({ name: 'test/probe' })];
    let notifyCount = 0;
    const unsubscribe = subscribeToExtensionLexicalExtensions(() => {
      notifyCount += 1;
    });

    setExtensionLexicalExtensions(arr);
    setExtensionLexicalExtensions(arr); // identical reference

    expect(notifyCount).toBe(1);
    unsubscribe();
  });

  it('runs the contributed register() hook against a live editor', () => {
    let registerCalled = false;
    let editorPassed: LexicalEditor | null = null;
    let cleanupCalled = false;

    const probe = defineExtension({
      name: 'test/probe',
      register: (editor) => {
        registerCalled = true;
        editorPassed = editor;
        return () => {
          cleanupCalled = true;
        };
      },
    });

    setExtensionLexicalExtensions([probe]);

    // Reproduce how `NimbalystEditor` composes the root extension with
    // store contributions. The host extension's `dependencies` array is
    // the merge of built-in deps + `getExtensionLexicalExtensions()`.
    const editor = buildEditorFromExtensions(
      defineExtension({
        name: 'test/host',
        dependencies: [...getExtensionLexicalExtensions()],
      }),
    );

    expect(registerCalled).toBe(true);
    expect(editorPassed).toBe(editor);
    expect(cleanupCalled).toBe(false);

    editor.dispose();
    expect(cleanupCalled).toBe(true);
  });

  it('honors configExtension overrides applied at the contribution boundary', () => {
    interface ProbeConfig {
      label: string;
    }
    let observed: string | null = null;

    const probe = defineExtension({
      name: 'test/configurable-probe',
      config: { label: 'default' } as ProbeConfig,
      register: (_editor, config) => {
        observed = config.label;
        return () => {};
      },
    });

    setExtensionLexicalExtensions([
      configExtension(probe, { label: 'overridden' }),
    ]);

    const editor = buildEditorFromExtensions(
      defineExtension({
        name: 'test/host',
        dependencies: [...getExtensionLexicalExtensions()],
      }),
    );

    expect(observed).toBe('overridden');
    editor.dispose();
  });
});
