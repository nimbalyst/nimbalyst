import { describe, it, expect } from 'vitest';
import { $convertFromMarkdownString } from '@lexical/markdown';
import { $getRoot, $createParagraphNode, $createTextNode, $isElementNode, TextNode } from 'lexical';
import { createHeadlessEditor } from '@lexical/headless';
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list';
import { CORE_TRANSFORMERS } from '../core-transformers';

describe('Text formatting in lists', () => {
  it('should import italic text in list items with single asterisk correctly', () => {
    const editor = createHeadlessEditor({
      nodes: [ListNode, ListItemNode],
      onError: (error) => {
        throw error;
      },
    });

    const markdown = `- *italic* not italic`;

    editor.update(
      () => {
        $convertFromMarkdownString(markdown, CORE_TRANSFORMERS);
      },
      { discrete: true }
    );

    editor.read(() => {
      const root = $getRoot();
      const list = root.getFirstChild();

      console.log('Root children:', root.getChildrenSize());
      console.log('List type:', list?.getType());

      if (list && list.getType() === 'list' && $isElementNode(list)) {
        const listItem = list.getFirstChild();
        console.log('List item type:', listItem?.getType());

        if (listItem && $isElementNode(listItem)) {
          const children = listItem.getAllTextNodes();
          console.log('Text nodes:', children.map((n: TextNode) => ({
            text: n.getTextContent(),
            format: n.getFormat(),
            hasBold: n.hasFormat('bold'),
            hasItalic: n.hasFormat('italic')
          })));
        }
      }

      // Should have a list with one item containing both italic and non-italic text
      expect(list?.getType()).toBe('list');

      const listItem = $isElementNode(list) ? list.getFirstChild() : null;
      expect(listItem?.getType()).toBe('listitem');

      const textNodes = (listItem && $isElementNode(listItem)) ? listItem.getAllTextNodes() : [];
      expect(textNodes.length).toBeGreaterThan(0);

      // First text node should be italic (contains "italic")
      const italicNode = textNodes.find((n: TextNode) => n.getTextContent() === 'italic');
      expect(italicNode).toBeDefined();
      expect(italicNode?.hasFormat('italic')).toBe(true);

      // Second text node should not be italic (contains " not italic")
      const normalNode = textNodes.find((n: TextNode) => n.getTextContent().includes('not italic'));
      expect(normalNode).toBeDefined();
      expect(normalNode?.hasFormat('italic')).toBe(false);
    });
  });

  it('should import italic text in list items with asterisks correctly', () => {
    const editor = createHeadlessEditor({
      nodes: [ListNode, ListItemNode],
      onError: (error) => {
        throw error;
      },
    });

    const markdown = `- *italic* not italic`;

    editor.update(
      () => {
        $convertFromMarkdownString(markdown, CORE_TRANSFORMERS);
      },
      { discrete: true }
    );

    editor.read(() => {
      const root = $getRoot();
      const list = root.getFirstChild();
      const listItem = (list && $isElementNode(list)) ? list.getFirstChild() : null;
      const textNodes = (listItem && $isElementNode(listItem)) ? listItem.getAllTextNodes() : [];

      console.log('Text nodes:', textNodes.map((n: TextNode) => ({
        text: n.getTextContent(),
        format: n.getFormat(),
        hasItalic: n.hasFormat('italic')
      })));

      // First text node should be italic
      const italicNode = textNodes.find((n: TextNode) => n.getTextContent() === 'italic');
      expect(italicNode).toBeDefined();
      expect(italicNode?.hasFormat('italic')).toBe(true);

      // Second text node should not be italic
      const normalNode = textNodes.find((n: TextNode) => n.getTextContent().includes('not italic'));
      expect(normalNode).toBeDefined();
      expect(normalNode?.hasFormat('italic')).toBe(false);
    });
  });

  it('should import bold text in list items with double asterisks correctly', () => {
    const editor = createHeadlessEditor({
      nodes: [ListNode, ListItemNode],
      onError: (error) => {
        throw error;
      },
    });

    const markdown = `- **bold** not bold`;

    editor.update(
      () => {
        $convertFromMarkdownString(markdown, CORE_TRANSFORMERS);
      },
      { discrete: true }
    );

    editor.read(() => {
      const root = $getRoot();
      const list = root.getFirstChild();
      const listItem = (list && $isElementNode(list)) ? list.getFirstChild() : null;
      const textNodes = (listItem && $isElementNode(listItem)) ? listItem.getAllTextNodes() : [];

      console.log('Text nodes:', textNodes.map((n: TextNode) => ({
        text: n.getTextContent(),
        format: n.getFormat(),
        hasBold: n.hasFormat('bold')
      })));

      // First text node should be bold
      const boldNode = textNodes.find((n: TextNode) => n.getTextContent() === 'bold');
      expect(boldNode).toBeDefined();
      expect(boldNode?.hasFormat('bold')).toBe(true);

      // Second text node should not be bold
      const normalNode = textNodes.find((n: TextNode) => n.getTextContent().includes('not bold'));
      expect(normalNode).toBeDefined();
      expect(normalNode?.hasFormat('bold')).toBe(false);
    });
  });

  it('should handle multiple formatting types in list items', () => {
    const editor = createHeadlessEditor({
      nodes: [ListNode, ListItemNode],
      onError: (error) => {
        throw error;
      },
    });

    const markdown = `- **bold** and *italic* and normal`;

    editor.update(
      () => {
        $convertFromMarkdownString(markdown, CORE_TRANSFORMERS);
      },
      { discrete: true }
    );

    editor.read(() => {
      const root = $getRoot();
      const list = root.getFirstChild();
      const listItem = (list && $isElementNode(list)) ? list.getFirstChild() : null;
      const textNodes = (listItem && $isElementNode(listItem)) ? listItem.getAllTextNodes() : [];

      // Should have bold, italic, and normal text
      const boldNode = textNodes.find((n: TextNode) => n.getTextContent() === 'bold');
      expect(boldNode?.hasFormat('bold')).toBe(true);
      expect(boldNode?.hasFormat('italic')).toBe(false);

      const italicNode = textNodes.find((n: TextNode) => n.getTextContent() === 'italic');
      expect(italicNode?.hasFormat('italic')).toBe(true);
      expect(italicNode?.hasFormat('bold')).toBe(false);

      const normalNode = textNodes.find((n: TextNode) => n.getTextContent().includes('normal'));
      expect(normalNode?.hasFormat('bold')).toBe(false);
      expect(normalNode?.hasFormat('italic')).toBe(false);
    });
  });

  it('should handle formatting in nested list items', () => {
    const editor = createHeadlessEditor({
      nodes: [ListNode, ListItemNode],
      onError: (error) => {
        throw error;
      },
    });

    const markdown = `- **Parent** item\n  - *Child* item`;

    editor.update(
      () => {
        $convertFromMarkdownString(markdown, CORE_TRANSFORMERS);
      },
      { discrete: true }
    );

    editor.read(() => {
      const root = $getRoot();
      const list = root.getFirstChild();

      // Get all list items (including nested)
      const allTextNodes = (list && $isElementNode(list)) ? list.getAllTextNodes() : [];

      // Find bold text
      const boldNode = allTextNodes.find((n: TextNode) => n.getTextContent() === 'Parent');
      expect(boldNode?.hasFormat('bold')).toBe(true);

      // Find italic text
      const italicNode = allTextNodes.find((n: TextNode) => n.getTextContent() === 'Child');
      expect(italicNode?.hasFormat('italic')).toBe(true);
    });
  });
});