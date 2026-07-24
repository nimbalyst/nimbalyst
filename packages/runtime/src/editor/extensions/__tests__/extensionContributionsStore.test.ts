/**
 * Integration test for the extension contributions store -- the
 * replacement for the legacy `pluginRegistry` user-command and
 * markdown-transformer surface. Validates that:
 *
 * - Publishing under a stable source name merges into the global
 *   user-commands / transformers / dynamic-options output.
 * - Subscribers are notified on publish, replace, and removal.
 * - Errors thrown by a dynamic-options provider are isolated to that
 *   provider and don't propagate.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { createCommand } from 'lexical';
import type { Transformer } from '@lexical/markdown';

import {
  clearExtensionContributions,
  getAllExtensionDynamicOptions,
  getAllExtensionTransformers,
  getAllExtensionUserCommands,
  setExtensionContributions,
  subscribeToExtensionContributions,
} from '../extensionContributionsStore';
import type { UserCommand } from '../../types/PluginTypes';

const NOOP_TRANSFORMER = {
  type: 'text-match',
  dependencies: [],
  importRegExp: /noop/,
  regExp: /noop/,
  trigger: '',
  replace: () => null,
  export: () => null,
} as unknown as Transformer;

const SAMPLE_COMMAND: UserCommand = {
  title: 'Sample Action',
  description: 'For tests only',
  icon: 'science',
  keywords: ['sample'],
  command: createCommand('SAMPLE_TEST_COMMAND'),
};

describe('extensionContributionsStore', () => {
  beforeEach(() => {
    clearExtensionContributions('source-a');
    clearExtensionContributions('source-b');
    clearExtensionContributions('source-error');
  });

  it('starts empty for an unregistered source', () => {
    expect(getAllExtensionUserCommands()).toEqual([]);
    expect(getAllExtensionTransformers()).toEqual([]);
  });

  it('merges contributions across sources in insertion order', () => {
    setExtensionContributions('source-a', {
      userCommands: [SAMPLE_COMMAND],
      markdownTransformers: [NOOP_TRANSFORMER],
    });
    setExtensionContributions('source-b', {
      userCommands: [{ ...SAMPLE_COMMAND, title: 'Second' }],
    });

    expect(getAllExtensionUserCommands()).toHaveLength(2);
    expect(getAllExtensionUserCommands().map((c) => c.title)).toEqual([
      'Sample Action',
      'Second',
    ]);
    expect(getAllExtensionTransformers()).toEqual([NOOP_TRANSFORMER]);
  });

  it('notifies subscribers on publish and removal', () => {
    let notifyCount = 0;
    const unsubscribe = subscribeToExtensionContributions(() => {
      notifyCount += 1;
    });

    setExtensionContributions('source-a', { userCommands: [SAMPLE_COMMAND] });
    expect(notifyCount).toBe(1);

    clearExtensionContributions('source-a');
    expect(notifyCount).toBe(2);

    // Removing again is a no-op.
    clearExtensionContributions('source-a');
    expect(notifyCount).toBe(2);

    unsubscribe();
    setExtensionContributions('source-a', { userCommands: [SAMPLE_COMMAND] });
    expect(notifyCount).toBe(2);
  });

  it('collects dynamic options from every provider', async () => {
    setExtensionContributions('source-a', {
      getDynamicOptions: () => [
        {
          id: 'a',
          label: 'A',
          onSelect: () => {},
        },
      ],
    });
    setExtensionContributions('source-b', {
      getDynamicOptions: async () => [
        {
          id: 'b',
          label: 'B',
          onSelect: () => {},
        },
      ],
    });

    const options = await getAllExtensionDynamicOptions('query');
    expect(options.map((o) => o.id).sort()).toEqual(['a', 'b']);
  });

  it('isolates failures in a single provider from the rest of the picker', async () => {
    const consoleError = console.error;
    let errorLogged = false;
    console.error = () => {
      errorLogged = true;
    };

    try {
      setExtensionContributions('source-a', {
        getDynamicOptions: () => [
          { id: 'a', label: 'A', onSelect: () => {} },
        ],
      });
      setExtensionContributions('source-error', {
        getDynamicOptions: () => {
          throw new Error('boom');
        },
      });

      const options = await getAllExtensionDynamicOptions('query');
      expect(options.map((o) => o.id)).toEqual(['a']);
      expect(errorLogged).toBe(true);
    } finally {
      console.error = consoleError;
    }
  });
});
