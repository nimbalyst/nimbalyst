// @vitest-environment node
import { createHeadlessEditor } from '@lexical/headless';
import type { Transformer } from '@lexical/markdown';
import { $getRoot, $isElementNode, type LexicalNode } from 'lexical';
import { describe, expect, it } from 'vitest';

import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import { getHeadlessBodyTransformers } from '../../../markdown/headlessBodyTransformers';
import { $convertFromEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownImport';
import { fenceRoundTrip } from '../../fencedBlock/__tests__/fenceRoundTrip';
import { $isMentionNode } from '../MentionNodeCore';
import { dateShortcuts, formatRelativeDate } from '../mentionDates';
import { DocumentReferenceTransformer } from '../../../../plugins/DocumentLinkPlugin/DocumentLinkNode';

function mentionsIn(markdown: string, transformers: Transformer[] = getHeadlessBodyTransformers()): Array<[string, string, string]> {
  const editor = createHeadlessEditor({ nodes: [...HeadlessBodyNodes], onError: (error) => { throw error; } });
  editor.update(() => { $convertFromEnhancedMarkdownString(markdown, transformers); }, { discrete: true });
  const found: Array<[string, string, string]> = [];
  editor.getEditorState().read(() => {
    const walk = (node: LexicalNode) => {
      if ($isMentionNode(node)) found.push([node.getMentionKind(), node.getValue(), node.getLabel()]);
      if ($isElementNode(node)) node.getChildren().forEach(walk);
    };
    walk($getRoot());
  });
  return found;
}

describe('mention markdown', () => {
  it.each([
    ['a person', 'Ask [@Ada Lovelace](mailto:ada@example.com) about it.', [['person', 'ada@example.com', 'Ada Lovelace']]],
    ['a name with a bracket', String.raw`Ping [@Ada \] L](mailto:ada@example.com).`, [['person', 'ada@example.com', 'Ada ] L']]],
    ['a date', 'Due @2026-10-15, then review.', [['date', '2026-10-15', '']]],
    ['a date in parentheses and at the end', '(by @2026-10-15) and @2026-11-01.', [['date', '2026-10-15', ''], ['date', '2026-11-01', '']]],
    ['a person and a date in a list', '- [@Bo](mailto:bo@x.io) by @2026-01-02', [['person', 'bo@x.io', 'Bo'], ['date', '2026-01-02', '']]],
  ])('round-trips %s byte for byte and reads the chip', (_label, markdown, expected) => {
    const trip = fenceRoundTrip(markdown);
    expect(trip.errors).toEqual([]);
    expect(trip.exported).toBe(markdown);
    expect(trip.reexported).toBe(markdown);
    expect(mentionsIn(markdown)).toEqual(expected);
  });

  it('is not claimed as a file reference when reference transformers run first (main-process adapter order)', () => {
    const adapterOrder = [DocumentReferenceTransformer, ...getHeadlessBodyTransformers()];
    expect(mentionsIn('Ask [@Ada](mailto:ada@example.com).', adapterOrder)).toEqual([['person', 'ada@example.com', 'Ada']]);
  });

  it.each([
    ['an impossible date', 'On @2026-13-40 nothing.'],
    ['an email whose domain looks like a date', 'Mail ops@2026-10-15.example.com today.'],
    ['a plain mailto link', 'Write [Ada](mailto:ada@example.com).'],
    ['a date in a bare URL query', 'See https://example.com/?q=@2026-10-15 now.'],
    ['a date in a link target', 'See [results](https://example.com/?q=@2026-10-15).'],
    ['a date as an email local part', 'Mail a+@2026-10-15.example.com today.'],
    ['a date inside link text', 'See [due @2026-10-15](https://example.com/x).'],
    ['a date followed by a domain', 'Host @2026-10-15.example now.'],
  ])('leaves %s as text and exports it unchanged', (_label, markdown) => {
    expect(mentionsIn(markdown)).toEqual([]);
    expect(fenceRoundTrip(markdown).exported).toBe(markdown);
  });
});

describe('date mentions', () => {
  const now = new Date(2026, 9, 9, 15, 30); // Fri Oct 9 2026, afternoon local time

  it.each([
    ['2026-10-09', 'today'],
    ['2026-10-10', 'tomorrow'],
    ['2026-10-08', 'yesterday'],
    ['2026-10-15', 'in 6 days'],
    ['2026-10-06', '3 days ago'],
    ['2026-10-17', 'Oct 17'],
    ['2027-01-05', 'Jan 5, 2027'],
  ])('labels %s as "%s"', (iso, label) => {
    expect(formatRelativeDate(iso, now)).toBe(label);
  });

  it('offers shortcuts by prefix and a typed ISO date verbatim', () => {
    expect(dateShortcuts('', now).map((s) => [s.label, s.iso])).toEqual([
      ['Today', '2026-10-09'], ['Tomorrow', '2026-10-10'], ['Next week', '2026-10-16'],
    ]);
    expect(dateShortcuts('to', now).map((s) => s.label)).toEqual(['Today', 'Tomorrow']);
    expect(dateShortcuts('2026-12-31', now)).toEqual([{ label: '2026-12-31', iso: '2026-12-31' }]);
    expect(dateShortcuts('2026-02-30', now)).toEqual([]);
  });
});
