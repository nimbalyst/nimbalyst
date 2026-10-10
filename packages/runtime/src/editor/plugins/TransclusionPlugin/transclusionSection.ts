/**
 * Cut one section out of a page's markdown for a transclusion: from the
 * heading whose anchor matches through the line before the next heading of the
 * same or a higher level. Anchors use the slugs `HeadingAnchorExtension` and
 * the ```toc block give headings (`slugify`, then `-1`, `-2`, ... for a
 * repeated slug, counted over every heading in document order), so a link
 * copied from a heading's anchor finds the same heading here.
 *
 * Works on the markdown text so the transcluded content is the source's own
 * bytes, not a re-export. ATX headings only (Nimbalyst writes no setext
 * headings); lines inside fenced code blocks and the frontmatter are skipped.
 */

import { slugify } from '../../utils/headingSlug';

export type TransclusionSection =
  | { status: 'ok'; markdown: string; heading: string | null }
  | { status: 'missing-section'; anchor: string };

const HEADING_REGEX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE_REGEX = /^ {0,3}(`{3,}|~{3,})/;
const MARKDOWN_LINK_REGEX = /!?\[([^\]]*)\]\([^)]*\)/g;

/** The text a heading line renders as, before slugging (link targets dropped). */
function headingText(raw: string): string {
  return raw.replace(MARKDOWN_LINK_REGEX, '$1').replace(/\\(.)/g, '$1').trim();
}

function stripFrontmatter(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') return i + 1;
  }
  return 0;
}

interface HeadingLine {
  line: number;
  level: number;
  text: string;
  slug: string;
}

function collectHeadings(lines: string[], start: number): HeadingLine[] {
  const headings: HeadingLine[] = [];
  const taken = new Map<string, number>();
  let fence: string | null = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = line.match(FENCE_REGEX);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length && line.trim() === fenceMatch[1]) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    const match = line.match(HEADING_REGEX);
    if (!match) continue;
    const text = headingText(match[2] ?? '');
    const base = slugify(text);
    let slug = base;
    if (base) {
      const count = taken.get(base);
      if (count !== undefined) {
        slug = `${base}-${count + 1}`;
        taken.set(base, count + 1);
      } else {
        taken.set(base, 0);
      }
    }
    headings.push({ line: i, level: match[1]!.length, text, slug });
  }
  return headings;
}

function trimBlankLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start++;
  while (end > start && lines[end - 1]!.trim() === '') end--;
  return lines.slice(start, end).join('\n');
}

/**
 * The section of `markdown` under the heading `anchor` names, heading line
 * included; the whole page (without frontmatter) when `anchor` is null.
 */
export function extractTransclusionSection(markdown: string, anchor: string | null): TransclusionSection {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const bodyStart = stripFrontmatter(lines);
  if (!anchor) {
    return { status: 'ok', markdown: trimBlankLines(lines.slice(bodyStart)), heading: null };
  }
  const wanted = anchor.toLowerCase();
  const headings = collectHeadings(lines, bodyStart);
  const index = headings.findIndex((heading) => heading.slug === wanted);
  if (index < 0) return { status: 'missing-section', anchor };
  const heading = headings[index]!;
  const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
  const section = lines.slice(heading.line, next ? next.line : lines.length);
  return { status: 'ok', markdown: trimBlankLines(section), heading: heading.text };
}
