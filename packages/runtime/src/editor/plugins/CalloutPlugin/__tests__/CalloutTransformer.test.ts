// @vitest-environment jsdom
import { createHeadlessEditor } from '@lexical/headless';
import type { Transformer } from '@lexical/markdown';
import { $isListNode } from '@lexical/list';
import { $isQuoteNode } from '@lexical/rich-text';
import { buildEditorFromExtensions, defineExtension } from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  INSERT_PARAGRAPH_COMMAND,
  KEY_BACKSPACE_COMMAND,
} from 'lexical';
import { describe, expect, it } from 'vitest';

import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import { getHeadlessBodyTransformers } from '../../../markdown/headlessBodyTransformers';
import { $convertFromEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownImport';
import { $convertToEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownExport';
import { $createCalloutNode, $isCalloutNode, CalloutNode } from '../CalloutNode';
import { createCalloutTransformer } from '../CalloutTransformer';
import { INSERT_CALLOUT_COMMAND } from '../CalloutCommands';
import { CalloutExtension } from '../../../extensions/builtin/CalloutExtension';

const TRANSFORMERS: Transformer[] = [
  createCalloutTransformer(() => TRANSFORMERS),
  ...getHeadlessBodyTransformers(),
];

function roundTrip(markdown: string, inspect?: () => void): string {
  const editor = createHeadlessEditor({ nodes: [...HeadlessBodyNodes, CalloutNode], onError: (error) => { throw error; } });
  editor.update(() => { $convertFromEnhancedMarkdownString(markdown, TRANSFORMERS); }, { discrete: true });
  let out = '';
  editor.getEditorState().read(() => {
    inspect?.();
    out = $convertToEnhancedMarkdownString(TRANSFORMERS, { includeFrontmatter: false });
  });
  return out;
}

describe('callout markdown', () => {
  it.each(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])('round-trips a %s callout', (type) => {
    const md = `Before\n\n> [!${type}]\n> Body with **bold** text.\n\nAfter`;
    expect(roundTrip(md, () => {
      const callout = $getRoot().getChildAtIndex(2);
      expect($isCalloutNode(callout) && callout.getCalloutType()).toBe(type.toLowerCase());
    })).toBe(md);
  });

  it('keeps a custom title and nested blocks: lists, headings, quotes, other callouts', () => {
    const md = [
      '> [!WARNING] Personal JWT is for personal sync only',
      '> First paragraph.',
      '>',
      '> ## A heading',
      '>',
      '> - one',
      '> - two',
      '>',
      '> > a plain nested quote',
      '>',
      '> > [!TIP]',
      '> > nested callout',
    ].join('\n');
    expect(roundTrip(md, () => {
      const callout = $getRoot().getFirstChild();
      if (!$isCalloutNode(callout)) throw new Error('expected a callout');
      expect(callout.getTitle()).toBe('Personal JWT is for personal sync only');
      const kids = callout.getChildren();
      expect(kids.some($isListNode)).toBe(true);
      expect(kids.some($isQuoteNode)).toBe(true);
      expect(kids.some($isCalloutNode)).toBe(true);
    })).toBe(md);
  });

  it('leaves plain quotes and unknown markers as quotes, byte for byte', () => {
    const md = '> just a quote\n> second line\n\n> [!UNKNOWN] not a callout';
    expect(roundTrip(md, () => {
      expect($getRoot().getChildren().filter($isQuoteNode)).toHaveLength(2);
      expect($getRoot().getChildren().some($isCalloutNode)).toBe(false);
    })).toBe(md);
  });

  it('reads a marker only on the first line of a quote block', () => {
    const md = '> ordinary quote\n> [!NOTE]\n> still quote';
    expect(roundTrip(md, () => {
      expect($getRoot().getChildren().map((node) => node.getType())).toEqual(['quote']);
    })).toBe(md);
  });

  it('imports an empty callout with an editable paragraph and exports just the marker', () => {
    expect(roundTrip('> [!NOTE]', () => {
      const callout = $getRoot().getFirstChild();
      expect($isCalloutNode(callout) && callout.getChildrenSize()).toBe(1);
    })).toBe('> [!NOTE]');
  });
});

describe('callout editing', () => {
  function setup() {
    const editor = buildEditorFromExtensions(defineExtension({ name: 'callout-test', dependencies: [CalloutExtension] }));
    editor.update(() => {
      const paragraph = $createParagraphNode();
      $getRoot().clear().append(paragraph);
      paragraph.select();
    }, { discrete: true });
    return editor;
  }
  const anchorNode = () => {
    const selection = $getSelection();
    return $isRangeSelection(selection) ? selection.anchor.getNode() : null;
  };

  it('inserts a typed callout with the caret inside it', () => {
    const editor = setup();
    editor.update(() => { editor.dispatchCommand(INSERT_CALLOUT_COMMAND, 'warning'); }, { discrete: true });
    editor.getEditorState().read(() => {
      const callout = $getRoot().getChildren().find($isCalloutNode);
      expect(callout?.getCalloutType()).toBe('warning');
      expect($isCalloutNode(anchorNode()?.getParent())).toBe(true);
    });
  });

  it('a header click edits the title in place, and does nothing when read-only', () => {
    const editor = setup();
    const root = document.createElement('div');
    document.body.append(root);
    editor.setRootElement(root);
    editor.update(() => {
      $getRoot().clear().append($createCalloutNode('note').append($createParagraphNode()));
    }, { discrete: true });
    const click = () => root.querySelector<HTMLElement>('.callout-header')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    editor.setEditable(false);
    click();
    expect(root.querySelector('.callout-title-input')).toBeNull();
    editor.setEditable(true);
    click();
    const input = root.querySelector<HTMLInputElement>('.callout-title-input')!;
    expect(input.placeholder).toBe('Note');
    input.value = 'Read this first';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    editor.update(() => {}, { discrete: true });
    editor.getEditorState().read(() => {
      const callout = $getRoot().getFirstChild();
      expect($isCalloutNode(callout) && [callout.getCalloutType(), callout.getTitle()]).toEqual(['note', 'Read this first']);
    });
    expect(root.querySelector('.callout-header')?.textContent).toBe('Read this first');
    root.remove();
  });

  it('Enter on a trailing empty line steps out; Backspace at the start unwraps', () => {
    const editor = setup();
    editor.update(() => {
      const empty = $createParagraphNode();
      $getRoot().clear().append(
        $createCalloutNode('note').append($createParagraphNode().append($createTextNode('kept')), empty),
      );
      empty.select();
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    }, { discrete: true });
    editor.getEditorState().read(() => {
      const [callout, after] = $getRoot().getChildren();
      expect($isCalloutNode(callout) && callout.getChildrenSize()).toBe(1);
      expect($isParagraphNode(after) && after.is(anchorNode())).toBe(true);
    });

    editor.update(() => {
      const callout = $getRoot().getFirstChildOrThrow();
      if (!$isCalloutNode(callout)) throw new Error('expected a callout');
      callout.getFirstDescendant()?.selectStart();
      editor.dispatchCommand(KEY_BACKSPACE_COMMAND, null as unknown as KeyboardEvent);
    }, { discrete: true });
    editor.getEditorState().read(() => {
      expect($getRoot().getChildren().some($isCalloutNode)).toBe(false);
      expect($getRoot().getTextContent()).toContain('kept');
    });
  });
});
