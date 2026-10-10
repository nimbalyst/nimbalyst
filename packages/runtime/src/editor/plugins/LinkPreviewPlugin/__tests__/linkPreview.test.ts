// @vitest-environment node
/**
 * Web link previews: which links become a block, that the block writes back
 * the exact link it came from, and that the iframe only ever loads an
 * allowlisted provider's own embed URL.
 */

import { describe, expect, it } from 'vitest';
import { createHeadlessEditor } from '@lexical/headless';
import { LinkNode } from '@lexical/link';
import { $getRoot, type LexicalEditor } from 'lexical';

import { fenceRoundTrip } from '../../fencedBlock/__tests__/fenceRoundTrip';
import { $upgradeParagraphIsolatedLinkToEmbed } from '../../EmbedPlugin/embedUpgrade';
import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import { getHeadlessBodyTransformers } from '../../../markdown/headlessBodyTransformers';
import { $convertFromEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownImport';
import { $convertToEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownExport';
import { resolveExternalEmbed } from '../externalEmbeds';
import { defaultLinkPreviewMode } from '../linkPreviewLinks';
import { $insertLinkPreview, $isPastedLinkAlone } from '../linkPreviewInsert';
import { $isEmbeddedFileNode, type EmbeddedFileNode } from '../../EmbedPlugin/EmbeddedFileNodeCore';
import { $downgradeEmbedToLink } from '../../../extensions/builtin/EmbedExtension';

const withUpgrade = { setup: (editor: LexicalEditor) => { editor.registerNodeTransform(LinkNode, $upgradeParagraphIsolatedLinkToEmbed); } };

describe('link preview markdown', () => {
  it.each([
    '[Design review](https://www.figma.com/design/abc123DEF456/Spec?node-id=1-2 "preview=embed")',
    '[Pricing](https://example.com/pricing "preview=card future=kept")',
  ])('upgrades a lone preview link and writes it back byte-for-byte: %s', (markdown) => {
    const trip = fenceRoundTrip(`Intro.\n\n${markdown}\n\nAfter.`, withUpgrade);
    expect(trip.errors).toEqual([]);
    expect(trip.blockTypes).toContain('embedded-file');
    expect(trip.exported.trim()).toBe(`Intro.\n\n${markdown}\n\nAfter.`);
    expect(trip.reexported).toBe(trip.exported);
  });

  it.each([
    ['plain web link', '[Pricing](https://example.com/pricing)'],
    ['transclusion', '[Auth model](https://example.com/page/X#jwt "transclude preview=card")'],
    ['Tab-downgraded', '[Pricing](https://example.com/pricing "preview=card embed=false")'],
    ['non-http', '[Run](javascript:alert(1) "preview=card")'],
  ])('leaves a %s as a link', (_name, markdown) => {
    const trip = fenceRoundTrip(markdown, withUpgrade);
    expect(trip.blockTypes).toEqual(['paragraph']);
  });

  it('does not upgrade a preview link inside running text', () => {
    const trip = fenceRoundTrip('See [Pricing](https://example.com/pricing "preview=card") for details.', withUpgrade);
    expect(trip.blockTypes).toEqual(['paragraph']);
  });
});

describe('external embed allowlist', () => {
  it.each([
    ['https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1m5s', 'https://www.youtube-nocookie.com/embed/jNQXAC9IVRw?start=65'],
    ['https://youtu.be/jNQXAC9IVRw', 'https://www.youtube-nocookie.com/embed/jNQXAC9IVRw'],
    ['https://www.youtube.com/shorts/jNQXAC9IVRw', 'https://www.youtube-nocookie.com/embed/jNQXAC9IVRw'],
    ['https://vimeo.com/channels/staff/76979871', 'https://player.vimeo.com/video/76979871'],
    ['https://www.loom.com/share/0123456789abcdef0123456789abcdef?sid=x', 'https://www.loom.com/embed/0123456789abcdef0123456789abcdef'],
    [
      'https://www.figma.com/design/abc123DEF456/Spec?node-id=1-2',
      `https://www.figma.com/embed?embed_host=nimbalyst&url=${encodeURIComponent('https://www.figma.com/design/abc123DEF456/Spec?node-id=1-2')}`,
    ],
  ])('maps %s to the provider embed URL', (url, embedUrl) => {
    expect(resolveExternalEmbed(url)?.embedUrl).toBe(embedUrl);
  });

  it.each([
    'https://evil.example/watch?v=jNQXAC9IVRw',
    'https://www.youtube.com.evil.example/watch?v=jNQXAC9IVRw',
    'http://user:pw@www.youtube.com/watch?v=jNQXAC9IVRw',
    'javascript:alert(1)//youtube.com/watch?v=jNQXAC9IVRw',
    'file:///etc/passwd',
    'https://www.youtube.com/watch?v=short',
    'https://www.figma.com/community/plugin/1',
  ])('rejects %s', (url) => {
    expect(resolveExternalEmbed(url)).toBeNull();
  });

  it('defaults an allowlisted link to the player and anything else to a card', () => {
    expect(defaultLinkPreviewMode('https://youtu.be/jNQXAC9IVRw')).toBe('embed');
    expect(defaultLinkPreviewMode('https://example.com')).toBe('card');
    expect(defaultLinkPreviewMode('./notes.md')).toBeNull();
  });
});

describe('inserting a preview from a pasted link', () => {
  function runInEditor(markdown: string, act: () => void): string {
    const editor = createHeadlessEditor({ nodes: [...HeadlessBodyNodes], onError: (error) => { throw error; } });
    let out = '';
    editor.update(() => {
      $convertFromEnhancedMarkdownString(markdown, getHeadlessBodyTransformers(), undefined, true, false);
      act();
    }, { discrete: true });
    editor.read(() => {
      out = $convertToEnhancedMarkdownString(getHeadlessBodyTransformers(), { includeFrontmatter: false, shouldPreserveNewLines: true });
    });
    return out;
  }

  it('turns the lone link at the caret into a block, keeping its title attributes', () => {
    const out = runInEditor('[Talk](https://youtu.be/jNQXAC9IVRw "height=400")', () => {
      const link = $getRoot().getFirstDescendant()!.getParent() as LinkNode;
      link.selectEnd();
      expect($isPastedLinkAlone('https://youtu.be/jNQXAC9IVRw')).toBe(true);
      $insertLinkPreview('https://youtu.be/jNQXAC9IVRw', 'card');
    });
    expect(out.trim()).toBe('[Talk](https://youtu.be/jNQXAC9IVRw "height=400 preview=card")');
  });

  it('does not offer a block for a link pasted into a sentence', () => {
    runInEditor('See [it](https://example.com) here.', () => {
      const link = $getRoot().getAllTextNodes().find((node) => node.getTextContent() === 'it')!.getParent() as LinkNode;
      link.selectEnd();
      expect($isPastedLinkAlone('https://example.com')).toBe(false);
    });
  });
});

describe('preview link titles are kept as written', () => {
  it.each([
    '[Pricing](https://example.com/pricing "preview=card note=keep bare-token")',
    `[Pricing](https://example.com/pricing "preview=card caption='Hello world' extra=1")`,
  ])('round-trips %s byte-for-byte', (markdown) => {
    const trip = fenceRoundTrip(markdown, withUpgrade);
    expect(trip.blockTypes).toEqual(['embedded-file']);
    expect(trip.exported.trim()).toBe(markdown);
    expect(trip.reexported).toBe(trip.exported);
  });

  it('changes only the preview key when a pasted link becomes a block', () => {
    const out = runPaste(`[Talk](https://youtu.be/jNQXAC9IVRw "bare-token caption='A b' embed=false")`);
    expect(out.trim()).toBe(`[Talk](https://youtu.be/jNQXAC9IVRw "bare-token caption='A b' preview=card")`);
  });

  it('Tab downgrade adds embed=false and keeps the rest of the title', () => {
    const editor = createHeadlessEditor({ nodes: [...HeadlessBodyNodes], onError: (error) => { throw error; } });
    editor.registerNodeTransform(LinkNode, $upgradeParagraphIsolatedLinkToEmbed);
    let out = '';
    editor.update(() => {
      $convertFromEnhancedMarkdownString(`[P](https://example.com "preview=card bare-token caption='A b'")`, getHeadlessBodyTransformers(), undefined, true, false);
    }, { discrete: true });
    editor.update(() => {
      const node = $getRoot().getFirstChild();
      expect($isEmbeddedFileNode(node)).toBe(true);
      $downgradeEmbedToLink(node as EmbeddedFileNode);
    }, { discrete: true });
    editor.read(() => {
      out = $convertToEnhancedMarkdownString(getHeadlessBodyTransformers(), { includeFrontmatter: false, shouldPreserveNewLines: true });
    });
    expect(out.trim()).toBe(`[P](https://example.com "preview=card bare-token caption='A b' embed=false")`);
  });
});

function runPaste(markdown: string): string {
  const editor = createHeadlessEditor({ nodes: [...HeadlessBodyNodes], onError: (error) => { throw error; } });
  let out = '';
  editor.update(() => {
    $convertFromEnhancedMarkdownString(markdown, getHeadlessBodyTransformers(), undefined, true, false);
    const link = $getRoot().getFirstDescendant()!.getParent() as LinkNode;
    link.selectEnd();
    $insertLinkPreview(link.getURL(), 'card');
  }, { discrete: true });
  editor.read(() => {
    out = $convertToEnhancedMarkdownString(getHeadlessBodyTransformers(), { includeFrontmatter: false, shouldPreserveNewLines: true });
  });
  return out;
}
