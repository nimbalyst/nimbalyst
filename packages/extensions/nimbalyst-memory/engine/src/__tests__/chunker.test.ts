import { describe, it, expect } from 'vitest';
import { chunkMarkdown, stripFrontmatter, estimateTokens } from '../chunker.js';

describe('chunkMarkdown', () => {
  it('produces heading-aware chunks carrying the heading breadcrumb', () => {
    const md = [
      '---',
      'title: Sample',
      'tags: [a, b]',
      '---',
      '# Top',
      'Intro paragraph under top.',
      '',
      '## Alpha',
      'Alpha body paragraph.',
      '',
      '### Alpha Detail',
      'Detail body.',
      '',
      '## Beta',
      'Beta body.',
    ].join('\n');

    const chunks = chunkMarkdown('design/sample.md', 'design', md);

    // Frontmatter must not appear in any chunk.
    expect(chunks.every((c) => !c.text.includes('title: Sample'))).toBe(true);

    // Each chunk carries sourcePath/sourceClass and a stable ordinal id.
    expect(chunks[0].sourcePath).toBe('design/sample.md');
    expect(chunks[0].sourceClass).toBe('design');
    expect(chunks.map((c) => c.id)).toEqual(
      chunks.map((_, i) => `design/sample.md#${i}`)
    );

    // The deepest section's breadcrumb is the full heading path.
    const detail = chunks.find((c) => c.text.includes('Detail body.'));
    expect(detail?.headingPath).toEqual(['Top', 'Alpha', 'Alpha Detail']);

    // Sibling section resets the breadcrumb back to depth 2.
    const beta = chunks.find((c) => c.text.includes('Beta body.'));
    expect(beta?.headingPath).toEqual(['Top', 'Beta']);

    // Content hash is populated and deterministic.
    expect(chunks[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(chunkMarkdown('design/sample.md', 'design', md)[0].contentHash).toBe(
      chunks[0].contentHash
    );
  });

  it('does not treat ATX headings inside fenced code blocks as headings', () => {
    const md = [
      '# Real Heading',
      'Body.',
      '',
      '```sh',
      '# not a heading, just a shell comment',
      'echo hi',
      '```',
      '',
      'Trailing body.',
    ].join('\n');

    const chunks = chunkMarkdown('docs/x.md', 'docs', md);
    // Only one heading ⇒ every chunk shares the same breadcrumb.
    expect(new Set(chunks.map((c) => c.headingPath.join('>')))).toEqual(
      new Set(['Real Heading'])
    );
    // The fenced comment line survived intact inside a chunk.
    expect(chunks.some((c) => c.text.includes('# not a heading'))).toBe(true);
  });

  it('splits a long section into multiple bounded chunks', () => {
    const para = 'word '.repeat(400).trim(); // ~2000 chars ≈ 500 tokens
    const md = ['# Big', para, '', para, '', para].join('\n');
    const chunks = chunkMarkdown('docs/big.md', 'docs', md, {
      minTokens: 100,
      maxTokens: 200,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Allow some slack for the greedy packer, but nothing wildly oversized.
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(300);
    }
  });
});

describe('stripFrontmatter', () => {
  it('removes a leading YAML block and leaves bodies without one untouched', () => {
    expect(stripFrontmatter('---\na: 1\n---\nbody')).toBe('body');
    expect(stripFrontmatter('no frontmatter here')).toBe('no frontmatter here');
  });
});
