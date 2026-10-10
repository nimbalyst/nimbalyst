// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  createHumanCitation,
  findCitations,
  formatCitationMarkdown,
  formatCitationSummaryParts,
  parseCitationLink,
  summarizeCitations,
  type Citation,
} from '../citationSyntax';

describe('citationSyntax', () => {
  it('round-trips quotes, newlines, brackets and emphasis markers in snapshot values', () => {
    const citation = createHumanCitation({
      sessionId: 'sess/1 (a)',
      inputKind: 'answer',
      key: 'toolu_01AB',
      by: 'Greg Hinkle',
      email: 'greg@example.com',
      at: '2026-09-30T14:02:00Z',
      context: 'answering round 3, TD-8',
      sessionTitle: 'Tech Decisions (P6)',
      quote: 'Let\'s "not" kid [ourselves] about it.\nSecond line | *bold* 100%',
    });
    const markdown = formatCitationMarkdown(citation);
    expect(markdown).not.toContain('\n');
    // New citations are console links; the session, kind and key are in the path.
    expect(markdown.startsWith('[GH](https://console.nimbalyst.com/app/cite/sess%2F1%20%28a%29/answer/toolu_01AB "')).toBe(true);

    const found = findCitations(`Text ${markdown} more`);
    expect(found).toHaveLength(1);
    expect(found[0].citation).toEqual(citation);
    expect(formatCitationMarkdown(found[0].citation, found[0].rawTitle)).toBe(markdown);
  });

  it.each([
    ['a console link', 'https://console.nimbalyst.com/app/cite/s/prompt/p1'],
    ['a legacy nimbalyst:// link', 'nimbalyst://cite/s/prompt/p1'],
  ])('reads %s and writes it back byte for byte while it still describes the citation', (_name, href) => {
    const raw = 'quote=\'kept as written\' by=Greg unknown=1';
    const markdown = `[G](${href} "${raw}")`;
    const [occurrence] = findCitations(markdown);
    expect(occurrence.citation).toMatchObject({ kind: 'human', sessionId: 's', inputKind: 'prompt', key: 'p1', by: 'Greg', quote: 'kept as written' });
    expect(formatCitationMarkdown(occurrence.citation, occurrence.rawTitle, occurrence.rawHref)).toBe(markdown);
    const changed = { ...occurrence.citation, by: 'Ana' } as Citation;
    expect(formatCitationMarkdown(changed, occurrence.rawTitle, occurrence.rawHref)).toBe(
      `[G](${href} "by=Ana quote='kept as written'")`,
    );
    // Pointing at another input writes the new form.
    const moved = { ...occurrence.citation, key: 'p2' } as Citation;
    expect(formatCitationMarkdown(moved, occurrence.rawTitle, occurrence.rawHref)).toContain('(https://console.nimbalyst.com/app/cite/s/prompt/p2 ');
  });

  it('round-trips a citation of a Claude Code session, which never equals the same key in a Nimbalyst session', () => {
    const terminal = createHumanCitation({ agent: 'claude-code', sessionId: 'cc-1', inputKind: 'prompt', key: 'u-1', by: 'Dana Lee', quote: 'Use Flagship' });
    const markdown = formatCitationMarkdown(terminal);
    expect(markdown.startsWith('[DL](https://console.nimbalyst.com/app/cite/claude-code/cc-1/prompt/u-1 "')).toBe(true);
    const [found] = findCitations(markdown);
    expect(found.citation).toEqual(terminal);
    expect(formatCitationMarkdown(found.citation, found.rawTitle, found.rawHref)).toBe(markdown);

    const { agent: _agent, ...desktop } = terminal;
    expect(formatCitationMarkdown(desktop)).not.toBe(markdown);
    expect(formatCitationMarkdown(desktop, found.rawTitle, found.rawHref)).not.toContain('claude-code');
  });

  it('reads a source citation as an ordinary link titled cite, and nothing else as a citation', () => {
    expect(findCitations('See [TanStack docs](https://tanstack.com/table "cite").')[0].citation)
      .toEqual({ kind: 'source', target: 'https://tanstack.com/table', label: 'TanStack docs' });
    // Characters a link destination cannot hold are encoded, and read back.
    const source: Citation = { kind: 'source', target: 'https://x.dev/a (b)', label: 'X' };
    const markdown = formatCitationMarkdown(source);
    expect(markdown).toBe('[X](https://x.dev/a%20%28b%29 "cite")');
    expect(findCitations(markdown)[0].citation).toEqual(source);
    expect(findCitations('[plain](https://x.dev) [titled](https://x.dev "Docs") ![img](a.png "cite")')).toEqual([]);
    expect(parseCitationLink('x', 'nimbalyst://NIM-1')).toBeNull();
    expect(parseCitationLink('x', 'nimbalyst://cite/s/vote/k')).toBeNull();
    // Other console links are page links, not citations.
    expect(parseCitationLink('x', 'https://console.nimbalyst.com/app/page/abc')).toBeNull();
  });

  it('skips citations in code and summarizes the rest for the Sources line', () => {
    const human = formatCitationMarkdown(createHumanCitation({ sessionId: 's', inputKind: 'prompt', key: 'p', by: 'Greg Hinkle', email: 'g@x.dev' }));
    // Same person under an older display name: counted once, by email.
    const renamed = formatCitationMarkdown(createHumanCitation({ sessionId: 's', inputKind: 'prompt', key: 'q', by: 'Greg', email: 'G@x.dev' }));
    const doc = formatCitationMarkdown({ kind: 'source', target: 'collab://doc/abc', label: 'Spec' });
    // An older citation with no email joins the same person by name.
    const legacy = '[GH](nimbalyst://cite/s/answer/k "by=\'Greg Hinkle\'")';
    const markdown = [`One ${human} two ${renamed} \`${human}\``, '```', human, '```', `Three ${legacy} ${doc}`].join('\n');
    const found = findCitations(markdown);
    expect(found.map((o) => o.line)).toEqual([1, 1, 5, 5]);
    expect(formatCitationSummaryParts(summarizeCitations(found.map((o) => o.citation)))).toEqual([
      '3 from Greg Hinkle',
      '1 document',
    ]);
  });
});
