/**
 * The composer's rich-text dialect: editor state <-> `nimbalystMarkdown` text.
 *
 * The comment dialect is INLINE-ONLY (see `commentBodyParser`): a reader
 * renders `[Label](nimbalyst://...)`, `` `code` ``, `**strong**`, `*emphasis*`
 * and `:shortcode:`, and NOTHING else. A heading, a list, or a fenced block
 * would render as literal text in the posted message, so the composer must not
 * be able to produce one -- that is enforced by the node set and the
 * shortcut-transformer set in `ComposerLexicalInput`, and by this serializer,
 * which has no way to emit a block marker.
 *
 * This is deliberately not `@lexical/markdown`'s `$convertToMarkdownString`:
 * that speaks the full document dialect (blocks, escaping, link syntax) and
 * would emit constructs the reader turns back into literal asterisks.
 */

import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  type LexicalNode,
} from 'lexical';

import { $createComposerPillNode, $isComposerPillNode } from './ComposerPillNode';
import { labeledToken, type DraftPool } from './composerDraft';
import { parseAgentMentionUrn, parseMentionUrn } from './resourceUrn';

/** Inline forms the reader understands, minus the ones we keep literal. */
const SEED_TOKEN = new RegExp(
  [
    // [Label](nimbalyst://...)
    '\\[([^\\]\\n]{1,160})\\]\\((nimbalyst:\\/\\/[^\\s)]{1,512})\\)',
    // `inline code`
    '`([^`\\n]{1,400})`',
    // **strong**
    '\\*\\*([^*\\n]{1,400})\\*\\*',
    // *emphasis*
    '\\*([^*\\n]{1,400})\\*',
  ].join('|'),
  'g',
);

type InlineFormat = 'plain' | 'code' | 'bold' | 'italic';

interface Run {
  format: InlineFormat;
  text: string;
}

/**
 * The editor state as the message text.
 *
 * Must run inside `editorState.read()` / `editor.update()`.
 */
export function $serializeComposer(): string {
  const blocks: string[] = [];
  for (const child of $getRoot().getChildren()) {
    blocks.push($isElementNode(child) ? serializeInline(child.getChildren()) : child.getTextContent());
  }
  // Paragraphs only arise from an HTML paste; a blank line between them is what
  // that paste meant. Shift+Enter produces line breaks inside one paragraph.
  return blocks.join('\n\n');
}

function serializeInline(nodes: readonly LexicalNode[]): string {
  const runs: Run[] = [];

  const push = (format: InlineFormat, text: string) => {
    if (text.length === 0) return;
    const last = runs[runs.length - 1];
    if (last && last.format === format) last.text += text;
    else runs.push({ format, text });
  };

  for (const node of nodes) {
    if ($isComposerPillNode(node)) {
      push('plain', labeledToken(node.getLabel(), node.getUrn()));
      continue;
    }
    if ($isLineBreakNode(node)) {
      push('plain', '\n');
      continue;
    }
    if ($isTextNode(node)) {
      push(formatOf(node), node.getTextContent());
      continue;
    }
    // Anything else (an unregistered paste survivor) contributes its text only.
    push('plain', node.getTextContent());
  }

  return runs.map(wrap).join('');
}

function formatOf(node: LexicalNode & { hasFormat(type: 'bold' | 'italic' | 'code'): boolean }): InlineFormat {
  // Inline code is literal in the reader, so it wins: `**x**` inside code stays
  // asterisks either way, and wrapping it again would only add noise.
  if (node.hasFormat('code')) return 'code';
  // The reader has no bold-italic form -- `***x***` renders as a stray asterisk
  // around a bold run -- so bold wins and the italic marker is dropped rather
  // than emitting something that reads as literal punctuation to everyone else.
  if (node.hasFormat('bold')) return 'bold';
  if (node.hasFormat('italic')) return 'italic';
  return 'plain';
}

function wrap({ format, text }: Run): string {
  if (text.trim().length === 0) return text;
  // Markers have to hug the word: `** x **` is not strong to the reader.
  const leading = text.slice(0, text.length - text.trimStart().length);
  const trailing = text.slice(text.trimEnd().length);
  const core = text.trim();

  switch (format) {
    case 'code':
      return `${leading}\`${core}\`${trailing}`;
    case 'bold':
      return `${leading}**${core}**${trailing}`;
    case 'italic':
      return `${leading}*${core}*${trailing}`;
    default:
      return text;
  }
}

/**
 * Seed the editor from an existing message (edit mode).
 *
 * Only tokens the pool corroborates become pills, mirroring the reader's rule
 * that an uncorroborated token is text. `:shortcode:` and bare URNs are seeded
 * as literal text on purpose: substituting a glyph or minting a labeled token
 * would rewrite the author's bytes on a plain edit.
 *
 * Must run inside `editor.update()` or an `editorState` initializer.
 */
export function $seedComposer(text: string, pool: DraftPool): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  root.append(paragraph);

  if (text.length === 0) {
    paragraph.select();
    return;
  }

  let cursor = 0;
  SEED_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SEED_TOKEN.exec(text)) !== null) {
    const [raw, label, urn, code, strong, emphasis] = match;
    appendText(paragraph, text.slice(cursor, match.index), 'plain');
    cursor = match.index + raw.length;

    if (urn !== undefined) {
      const pill = pillFor(label, urn, pool);
      if (pill) paragraph.append(pill);
      else appendText(paragraph, raw, 'plain');
      continue;
    }
    if (code !== undefined) appendText(paragraph, code, 'code');
    else if (strong !== undefined) appendText(paragraph, strong, 'bold');
    else if (emphasis !== undefined) appendText(paragraph, emphasis, 'italic');
    else appendText(paragraph, raw, 'plain');
  }

  appendText(paragraph, text.slice(cursor), 'plain');
  paragraph.selectEnd();
}

function pillFor(label: string, urn: string, pool: DraftPool) {
  if (pool.people[urn] || parseMentionUrn(urn) !== null) {
    return pool.people[urn] ? $createComposerPillNode({ label, urn, kind: 'person' }) : null;
  }
  if (pool.agents[urn]) return $createComposerPillNode({ label, urn, kind: 'agent' });
  const ref = pool.refs[urn];
  if (ref) {
    const kind = parseAgentMentionUrn(urn) !== null ? 'agent' : 'resource';
    return $createComposerPillNode({ label, urn, kind, icon: resourceIcon(ref.kind) });
  }
  return null;
}

/** Kept in step with `commentViewModel`'s pill icons. */
export function resourceIcon(kind: string): string {
  switch (kind) {
    case 'tracker':
      return 'confirmation_number';
    case 'document':
      return 'description';
    case 'session':
      return 'smart_toy';
    case 'file':
      return 'draft';
    case 'commit':
      return 'commit';
    case 'pullRequest':
      return 'call_merge';
    case 'conversation':
      return 'forum';
    default:
      return 'link';
  }
}

function appendText(
  paragraph: ReturnType<typeof $createParagraphNode>,
  text: string,
  format: InlineFormat,
): void {
  if (text.length === 0) return;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) paragraph.append($createLineBreakNode());
    if (line.length === 0) return;
    const node = $createTextNode(line);
    if (format === 'code') node.toggleFormat('code');
    else if (format === 'bold') node.toggleFormat('bold');
    else if (format === 'italic') node.toggleFormat('italic');
    paragraph.append(node);
  });
}
