/**
 * Round-trip tests for tracker reference markdown handling.
 *
 * A tracker reference is stored as `[NIM-123](nimbalyst://NIM-123)` and must:
 *  - import into a TrackerReferenceNode carrying ONLY the reference key,
 *  - export back to the same markdown,
 *  - not be captured by the document-link transformer (which excludes `://`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEditor, $getRoot } from 'lexical';
import { ListNode, ListItemNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { $convertToMarkdownString, type Transformer } from '@lexical/markdown';
import { $convertFromEnhancedMarkdownString } from '../../../editor/markdown/EnhancedMarkdownImport';
import { CORE_TRANSFORMERS } from '../../../editor/markdown/core-transformers';
import {
  TrackerReferenceNode,
  $isTrackerReferenceNode,
} from '../TrackerReferenceNode';
import { TrackerReferenceTransformer } from '../TrackerReferenceTransformer';

function getTestTransformers(): Transformer[] {
  return [TrackerReferenceTransformer, ...CORE_TRANSFORMERS];
}

function makeEditor(): ReturnType<typeof createEditor> {
  return createEditor({
    nodes: [
      HeadingNode,
      QuoteNode,
      ListNode,
      ListItemNode,
      CodeNode,
      LinkNode,
      TrackerReferenceNode,
    ],
    onError: (e) => {
      throw e;
    },
  });
}

describe('TrackerReferenceTransformer', () => {
  let editor: ReturnType<typeof createEditor>;

  beforeEach(() => {
    editor = makeEditor();
  });

  it('imports a nimbalyst:// link into a TrackerReferenceNode with only the key', () => {
    editor.update(
      () => {
        $convertFromEnhancedMarkdownString(
          'See [NIM-123](nimbalyst://NIM-123) for details.',
          getTestTransformers(),
        );
      },
      { discrete: true },
    );

    let found: TrackerReferenceNode | null = null;
    editor.read(() => {
      const walk = (node: ReturnType<typeof $getRoot>) => {
        for (const child of node.getChildren?.() ?? []) {
          if ($isTrackerReferenceNode(child)) {
            found = child;
          } else if ('getChildren' in child) {
            // @ts-expect-error recursive element walk
            walk(child);
          }
        }
      };
      walk($getRoot());
    });

    expect(found).not.toBeNull();
    expect(found!.getReferenceKey()).toBe('NIM-123');
  });

  it('round-trips [NIM-123](nimbalyst://NIM-123) back to identical markdown', () => {
    editor.update(
      () => {
        $convertFromEnhancedMarkdownString(
          'See [NIM-123](nimbalyst://NIM-123) for details.',
          getTestTransformers(),
        );
      },
      { discrete: true },
    );

    let exported = '';
    editor.update(
      () => {
        exported = $convertToMarkdownString(getTestTransformers());
      },
      { discrete: true },
    );

    expect(exported).toContain('[NIM-123](nimbalyst://NIM-123)');
  });

  it('supports local short-id reference keys (tk_...)', () => {
    editor.update(
      () => {
        $convertFromEnhancedMarkdownString(
          '[tk_a1b2c3](nimbalyst://tk_a1b2c3)',
          getTestTransformers(),
        );
      },
      { discrete: true },
    );

    let exported = '';
    editor.update(
      () => {
        exported = $convertToMarkdownString(getTestTransformers());
      },
      { discrete: true },
    );

    expect(exported).toContain('[tk_a1b2c3](nimbalyst://tk_a1b2c3)');
  });
});
