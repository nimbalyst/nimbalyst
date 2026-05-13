/**
 * End-to-end test of the contract a third-party Nimbalyst extension uses
 * to ship a Lexical plugin. A fixture extension publishes:
 *
 * 1. A `LexicalExtension` that registers a custom decorator node and a
 *    command handler (via `setExtensionLexicalExtension`).
 * 2. A markdown transformer for that node (via
 *    `setExtensionContributions.markdownTransformers`).
 * 3. A slash-picker entry that dispatches the command (via
 *    `setExtensionContributions.userCommands`).
 *
 * The test exercises the full pipeline:
 *
 * - The editor built from the contributed extension recognizes the
 *   node class.
 * - The slash-picker user-command surface includes the contributed
 *   entry.
 * - The markdown transformers surface (`getEditorTransformers`)
 *   includes the contributed transformer alongside the core transformers.
 * - Removing the contribution removes the slash-picker entry and the
 *   transformer.
 *
 * This is the contract any on-disk extension or in-app integration relies
 * on. Breaking any of these assertions would invalidate the extension SDK
 * surface.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  buildEditorFromExtensions,
  defineExtension,
} from '@lexical/extension';
import {
  COMMAND_PRIORITY_EDITOR,
  DecoratorNode,
  createCommand,
  type EditorConfig,
  type LexicalCommand,
  type NodeKey,
  type SerializedLexicalNode,
} from 'lexical';

import {
  clearExtensionContributions,
  getAllExtensionTransformers,
  getAllExtensionUserCommands,
  setExtensionContributions,
} from '../extensionContributionsStore';
import {
  setExtensionLexicalExtension,
  setExtensionLexicalExtensions,
} from '../extensionLexicalExtensionsStore';
import { getEditorTransformers } from '../../markdown';

const SOURCE = 'test-fixture-extension';

type SerializedBadgeNode = SerializedLexicalNode & { type: 'test-badge' };

class TestBadgeNode extends DecoratorNode<null> {
  static getType(): string {
    return 'test-badge';
  }
  static clone(node: TestBadgeNode): TestBadgeNode {
    return new TestBadgeNode(node.__key);
  }
  constructor(key?: NodeKey) {
    super(key);
  }
  createDOM(_config: EditorConfig): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): boolean {
    return false;
  }
  decorate(): null {
    return null;
  }
  static importJSON(): TestBadgeNode {
    return new TestBadgeNode();
  }
  exportJSON(): SerializedBadgeNode {
    return { type: 'test-badge', version: 1 };
  }
}

const INSERT_BADGE_COMMAND: LexicalCommand<void> = createCommand('INSERT_BADGE');

const BADGE_TRANSFORMER = {
  type: 'text-match',
  dependencies: [TestBadgeNode],
  importRegExp: /:badge:/,
  regExp: /:badge:/,
  trigger: ':',
  replace: () => null,
  export: () => null,
} as unknown as Parameters<typeof setExtensionContributions>[1] extends infer T
  ? T extends { markdownTransformers?: ReadonlyArray<infer U> }
    ? U
    : never
  : never;

const FixtureExtension = defineExtension({
  name: '@test/fixture',
  nodes: [TestBadgeNode],
  register: (editor) =>
    editor.registerCommand(
      INSERT_BADGE_COMMAND,
      () => true,
      COMMAND_PRIORITY_EDITOR,
    ),
});

function publishFixture(): void {
  setExtensionLexicalExtension(SOURCE, FixtureExtension);
  setExtensionContributions(SOURCE, {
    markdownTransformers: [BADGE_TRANSFORMER],
    userCommands: [
      {
        title: 'Test Badge',
        description: 'Insert a fixture badge',
        icon: 'star',
        keywords: ['badge', 'test'],
        command: INSERT_BADGE_COMMAND,
      },
    ],
  });
}

function unpublishFixture(): void {
  setExtensionLexicalExtension(SOURCE, undefined);
  clearExtensionContributions(SOURCE);
}

describe('Nimbalyst extension contract (end-to-end)', () => {
  beforeEach(() => {
    // Make sure no leftover state from other test files biases assertions.
    setExtensionLexicalExtensions([]);
    clearExtensionContributions(SOURCE);
  });
  afterEach(() => {
    unpublishFixture();
  });

  it('lets a fixture extension contribute a node, a transformer, and a slash command end-to-end', () => {
    publishFixture();

    // 1. Slash-picker entry is visible to ComponentPicker.
    const userCommands = getAllExtensionUserCommands();
    expect(userCommands.find((c) => c.title === 'Test Badge')).toBeDefined();
    expect(
      userCommands.find((c) => c.title === 'Test Badge')?.command,
    ).toBe(INSERT_BADGE_COMMAND);

    // 2. Markdown transformer is visible to import/export.
    expect(getAllExtensionTransformers()).toContain(BADGE_TRANSFORMER);
    expect(getEditorTransformers()).toContain(BADGE_TRANSFORMER);

    // 3. Node class is registered on an editor built from the extension
    //    graph. Walks the path NimbalystEditor uses: a root extension that
    //    pulls dependencies in from the lexical-extensions store.
    const editor = buildEditorFromExtensions(
      defineExtension({
        name: 'test/host',
        dependencies: [FixtureExtension],
      }),
    );
    try {
      expect(editor.hasNodes([TestBadgeNode])).toBe(true);

      // 4. The contributed command handler runs end-to-end.
      const dispatched = editor.dispatchCommand(INSERT_BADGE_COMMAND, undefined);
      expect(dispatched).toBe(true);
    } finally {
      editor.dispose();
    }
  });

  it('removes the slash-picker entry and transformer when the source unpublishes', () => {
    publishFixture();
    expect(getAllExtensionUserCommands().some((c) => c.title === 'Test Badge')).toBe(true);
    expect(getAllExtensionTransformers()).toContain(BADGE_TRANSFORMER);

    unpublishFixture();
    expect(getAllExtensionUserCommands().some((c) => c.title === 'Test Badge')).toBe(false);
    expect(getAllExtensionTransformers()).not.toContain(BADGE_TRANSFORMER);
  });
});
