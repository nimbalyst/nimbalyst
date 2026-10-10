// @vitest-environment node
import { createHeadlessEditor } from '@lexical/headless';
import { $isLinkNode } from '@lexical/link';
import { $getRoot, $isElementNode, $isParagraphNode, type LexicalNode } from 'lexical';
import { describe, expect, it } from 'vitest';

import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import { getHeadlessBodyTransformers } from '../../../markdown/headlessBodyTransformers';
import { $convertFromEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownImport';
import { $convertToEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownExport';
import { $createTransclusionNode, $downgradeTransclusionToLink, $upgradeLinkToTransclusion } from '../TransclusionNodeCore';
import { createReadSequencer } from '../transclusionHost';

import { fenceRoundTrip } from '../../fencedBlock/__tests__/fenceRoundTrip';
import { checkTransclusionNesting, MAX_TRANSCLUSION_DEPTH, parseTransclusionHref, transclusionTargetKey } from '../transclusionLink';
import { extractTransclusionSection } from '../transclusionSection';

const TEAM_PAGE = 'https://console.nimbalyst.com/org/o1/project/p1/document/doc-1';

describe('transclusion markdown', () => {
  it.each([
    ['a team page section', `[Auth model](${TEAM_PAGE}#jwt-scopes "transclude")`],
    ['a Personal page', '[Notes](https://console.nimbalyst.com/app/page/pp-1 "transclude")'],
    ['a typed page', '[NIM-12](https://console.nimbalyst.com/org/o1/project/p1/page/item/NIM-12 "transclude")'],
    ['a nimbalyst://doc link', '[Auth](nimbalyst://doc/doc-1?orgId=o1#jwt-scopes "transclude")'],
    ['a collab:// link with extra tokens', "[Auth](collab://org:o1:doc:doc-1 \"transclude height=300\")"],
  ])('round-trips %s byte for byte through the headless set', (_label, markdown) => {
    const trip = fenceRoundTrip(markdown);
    expect(trip.errors).toEqual([]);
    expect(trip.exported).toBe(markdown);
    expect(trip.reexported).toBe(markdown);
  });
});

/** Import headless, apply the editor's upgrade rule to every link, export. */
function upgradeAndExport(markdown: string): { types: string[]; exported: string } {
  const transformers = getHeadlessBodyTransformers();
  const editor = createHeadlessEditor({ nodes: [...HeadlessBodyNodes], onError: (error) => { throw error; } });
  editor.update(() => { $convertFromEnhancedMarkdownString(markdown, transformers); }, { discrete: true });
  editor.update(() => {
    const links: LexicalNode[] = [];
    const walk = (node: LexicalNode) => {
      if ($isLinkNode(node)) links.push(node);
      else if ($isElementNode(node)) node.getChildren().forEach(walk);
    };
    walk($getRoot());
    for (const link of links) if ($isLinkNode(link)) $upgradeLinkToTransclusion(link);
  }, { discrete: true });
  return editor.getEditorState().read(() => ({
    // Blank lines between blocks import as empty paragraphs.
    types: $getRoot().getChildren()
      .filter((child) => !($isParagraphNode(child) && child.getTextContent() === ''))
      .map((child) => child.getType()),
    exported: $convertToEnhancedMarkdownString(transformers, { includeFrontmatter: false, shouldPreserveNewLines: true }),
  }));
}

describe('transclusion upgrade', () => {
  it('turns a lone transclude link into the block and exports the same bytes', () => {
    const markdown = `Before\n\n[Auth model](${TEAM_PAGE}#jwt-scopes "transclude")\n\n[NIM-12](https://console.nimbalyst.com/org/o1/project/p1/page/item/NIM-12 'transclude')`;
    const { types, exported } = upgradeAndExport(markdown);
    expect(types).toEqual(['paragraph', 'transclusion', 'transclusion']);
    expect(exported).toBe(markdown.replace("'transclude'", '"transclude"'));
  });

  it('leaves inline, non-page and untitled links alone', () => {
    const markdown = [
      `See [Auth](${TEAM_PAGE} "transclude") inline.`,
      '[Elsewhere](https://example.com/x "transclude")',
      `[Auth](${TEAM_PAGE})`,
    ].join('\n\n');
    expect(upgradeAndExport(markdown)).toEqual({ types: ['paragraph', 'paragraph', 'paragraph'], exported: markdown });
  });
});

describe('transclusion edge cases', () => {
  it('keeps a link with a malformed escape an ordinary link instead of aborting the import', () => {
    const markdown = ['Before', '[Auth](nimbalyst://doc/D?orgId=%ZZ "transclude")', '[Auth](nimbalyst://doc/%ZZ "transclude")', 'After'].join('\n\n');
    expect(() => parseTransclusionHref('nimbalyst://doc/D?orgId=%ZZ')).not.toThrow();
    expect(parseTransclusionHref('nimbalyst://doc/%ZZ')).toBeNull();
    expect(upgradeAndExport(markdown)).toEqual({ types: ['paragraph', 'paragraph', 'paragraph', 'paragraph'], exported: markdown });
  });

  it('"Show as link" drops the transclude token, keeps the rest, and does not re-upgrade', () => {
    const editor = createHeadlessEditor({ nodes: [...HeadlessBodyNodes], onError: (error) => { throw error; } });
    const results: Array<[string | null, boolean]> = [];
    editor.update(() => {
      for (const title of ['transclude height=300', 'transclude']) {
        const node = $createTransclusionNode(TEAM_PAGE, 'Auth', title);
        $getRoot().append(node);
        const link = $downgradeTransclusionToLink(node);
        results.push([link.getTitle(), $upgradeLinkToTransclusion(link)]);
      }
    }, { discrete: true });
    expect(results).toEqual([['height=300', false], [null, false]]);
  });

  it('discards a read that a newer read or a deletion superseded, including its errors', () => {
    const seq = createReadSequencer();
    const states: string[] = [];
    const readA = seq.next();
    const readB = seq.next();
    if (readB()) states.push('B');
    if (readA()) states.push('A (old)');
    const readC = seq.next();
    seq.next(); // the page was deleted; "missing" emitted synchronously
    if (readC()) states.push('C ready after delete');
    if (readC()) states.push('C error after delete');
    expect(states).toEqual(['B']);
  });
});

describe('transclusion targets', () => {
  it('reads every page link form, splitting off the anchor', () => {
    const team = parseTransclusionHref(`${TEAM_PAGE}#jwt-scopes`);
    expect(team).toMatchObject({ target: { kind: 'page', pageId: 'doc-1' }, anchor: 'jwt-scopes', pageHref: TEAM_PAGE });
    const deep = parseTransclusionHref('nimbalyst://doc/doc-1?orgId=o1');
    expect(deep).toMatchObject({ target: { kind: 'collabDoc', documentId: 'doc-1', orgId: 'o1' }, anchor: null });
    // A team page's console link and its nimbalyst:// link are the same page for cycle detection.
    expect(transclusionTargetKey(team!.target)).toBe(transclusionTargetKey(deep!.target));
    expect(parseTransclusionHref('https://console.nimbalyst.com/app/page/pp-1')?.target).toEqual({ kind: 'page', scope: 'local', pageId: 'pp-1' });
    expect(parseTransclusionHref('https://console.nimbalyst.com/app/item/NIM-3')?.target).toEqual({ kind: 'item', scope: 'local', itemRef: 'NIM-3' });
    expect(parseTransclusionHref('https://example.com/page#x')).toBeNull();
    expect(parseTransclusionHref('https://console.nimbalyst.com/org/o1/project/p1/view/type/bug')).toBeNull();
  });

  it('stops a cycle and caps nesting depth', () => {
    expect(checkTransclusionNesting(['doc:a'], 0, 'doc:b')).toBe('ok');
    expect(checkTransclusionNesting(['doc:a', 'doc:b'], 1, 'doc:a')).toBe('cycle');
    expect(checkTransclusionNesting(['doc:a', 'doc:b', 'doc:c', 'doc:d'], MAX_TRANSCLUSION_DEPTH, 'doc:e')).toBe('too-deep');
  });
});

describe('transclusion sections', () => {
  const page = [
    '---',
    'title: Auth',
    '---',
    '# Auth',
    'Intro.',
    '## JWT scopes',
    'Personal vs team.',
    '### Rotation',
    'Keys rotate.',
    '```md',
    '## Not a heading',
    '```',
    '## [Links](https://x.io) & refs',
    'Refs.',
    '## JWT scopes',
    'Second one.',
    '# Appendix',
  ].join('\n');

  it('runs from the heading to the next heading of the same or higher level', () => {
    expect(extractTransclusionSection(page, 'jwt-scopes')).toEqual({
      status: 'ok',
      heading: 'JWT scopes',
      markdown: '## JWT scopes\nPersonal vs team.\n### Rotation\nKeys rotate.\n```md\n## Not a heading\n```',
    });
  });

  it('numbers repeated slugs like the heading anchors and slugs link text, not targets', () => {
    expect(extractTransclusionSection(page, 'jwt-scopes-1')).toMatchObject({ status: 'ok', markdown: '## JWT scopes\nSecond one.' });
    expect(extractTransclusionSection(page, 'links-refs')).toMatchObject({ status: 'ok', heading: 'Links & refs' });
    expect(extractTransclusionSection(page, 'not-a-heading')).toEqual({ status: 'missing-section', anchor: 'not-a-heading' });
  });

  it('returns the whole page without frontmatter when there is no anchor', () => {
    const whole = extractTransclusionSection(page, null);
    expect(whole.status === 'ok' && whole.markdown.startsWith('# Auth\nIntro.')).toBe(true);
  });
});
