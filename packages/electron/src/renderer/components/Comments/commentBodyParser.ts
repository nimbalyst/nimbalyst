/**
 * Body parsing: `RichCommentBody` -> renderable segments.
 *
 * ENTITY AUTHORITY AND LEGACY FALLBACK
 *
 * V1 bodies may carry byte-offset entities. When present, those entities are
 * the only source of mention and resource placement; token-looking text
 * outside an entity stays text. Bodies without entities use the legacy token
 * grammar plus corroboration so stored pre-entity messages keep rendering:
 *
 *   [Label](nimbalyst://...)   composer-inserted, label is display-only
 *   nimbalyst://...            bare, as produced by pasting a copied link
 *
 * A legacy token only becomes a pill or a mention if it is CORROBORATED by the
 * out-of-band, server-recomputed lists on the comment:
 *
 *   resource pill   <- a matching entry in `Comment.resourceRefs`
 *   person mention  <- `deliveryHints.mentionedUserIds` contains the user id
 *   agent mention   <- `deliveryHints.mentionedAgentSessionIds` contains it
 *
 * An uncorroborated token renders as literal text. That inversion is the whole
 * safety property: body text is attacker-controlled prose, the ref and hint
 * lists are server-validated, so nothing in prose alone can mint an authorized
 * pill or fake a mention of someone who was never notified.
 *
 * `plainText` exits before either path and performs no inline interpretation,
 * including no emoji shortcode substitution.
 */

import { validateRichCommentBody } from '@nimbalyst/collab-protocol';
import type {
  BodyEntity,
  BodySegment,
  MentionDirectory,
  MessageAttachment,
  MessageAttachmentView,
  ResourcePillView,
  ResourceRef,
  RichCommentBody,
} from './commentTypes';
import { emojiGlyph } from './emojiCatalog';
import { parseAgentMentionUrn, parseMentionUrn, resourceRefToUrn } from './resourceUrn';

/**
 * One pass over the body. Alternation order matters: the labeled-link form has
 * to win over the bare-URN form, or `[x](nimbalyst://a)` would tokenize as text
 * plus a bare URN and lose its label.
 */
const TOKEN = new RegExp(
  [
    // [Label](nimbalyst://...)
    '\\[([^\\]\\n]{1,160})\\]\\((nimbalyst:\\/\\/[^\\s)]{1,512})\\)',
    // bare nimbalyst:// URN
    '(nimbalyst:\\/\\/[A-Za-z0-9._~%!$&\'*+,;=:@\\-\\/]{1,512})',
    // `inline code`
    '`([^`\\n]{1,400})`',
    // **strong**
    '\\*\\*([^*\\n]{1,400})\\*\\*',
    // *emphasis*
    '\\*([^*\\n]{1,400})\\*',
    // :shortcode:
    ':([a-z0-9_+\\-]{1,40}):',
  ].join('|'),
  'g',
);

const INLINE_TOKEN = new RegExp(
  [
    // `inline code`
    '`([^`\\n]{1,400})`',
    // **strong**
    '\\*\\*([^*\\n]{1,400})\\*\\*',
    // *emphasis*
    '\\*([^*\\n]{1,400})\\*',
    // :shortcode:
    ':([a-z0-9_+\\-]{1,40}):',
  ].join('|'),
  'g',
);

export interface ParseBodyContext {
  /** Server-validated refs. Only these can become pills. */
  resourceRefs: readonly ResourceRef[];
  /** Server-recomputed mention hints. Only these can become mentions. */
  mentionedUserIds: readonly string[];
  mentionedAgentSessionIds: readonly string[];
  directory: MentionDirectory;
  viewerUserId: string;
  /** Redacted pill views keyed by URN, produced by the view model. */
  pills: Record<string, ResourcePillView>;
  /**
   * Asset namespace the body's attachments resolve against -- the conversation
   * id for a message, the document id for a document discussion. Without it
   * attachments have no address and are dropped rather than guessed at.
   */
  assetDocumentId?: string;
}

export function parseCommentBody(body: RichCommentBody, ctx: ParseBodyContext): BodySegment[] {
  return withAttachments(parseTextSegments(body, ctx), body, ctx);
}

function parseTextSegments(body: RichCommentBody, ctx: ParseBodyContext): BodySegment[] {
  if (body.text.length === 0) return [];
  if (body.format === 'plainText') return [{ type: 'text', text: body.text }];

  if (body.entities !== undefined) {
    const validation = validateRichCommentBody(body, {
      resourceRefs: ctx.resourceRefs,
      deliveryHints: {
        mentionedUserIds: ctx.mentionedUserIds,
        mentionedAgentSessionIds: ctx.mentionedAgentSessionIds,
      },
    });
    if (!validation.valid) return [{ type: 'text', text: body.text }];
    return parseEntityBody(body, ctx);
  }

  return parseLegacyBody(body.text, ctx);
}

/**
 * Attachments render after the text, as one block.
 *
 * Appended here rather than woven into either text path, so a body with no
 * files produces exactly the segment list it produced before this existed --
 * which is what keeps the parser's contract corpus meaningful.
 */
function withAttachments(
  segments: BodySegment[],
  body: RichCommentBody,
  ctx: ParseBodyContext,
): BodySegment[] {
  const attachments = body.attachments;
  if (attachments === undefined || attachments.length === 0) return segments;
  if (!ctx.assetDocumentId) return segments;
  const views = attachments.map((attachment) =>
    toAttachmentView(attachment, ctx.assetDocumentId!),
  );
  return [...segments, { type: 'attachments', attachments: views }];
}

/**
 * Types rendered inline as pictures.
 *
 * A fixed list, not a `startsWith('image/')` test: the MIME type is authored by
 * another client, and `image/svg+xml` is a document that can carry script, so
 * it renders as a file chip like anything else this list does not name.
 */
const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
]);

export function toAttachmentView(
  attachment: MessageAttachment,
  documentId: string,
): MessageAttachmentView {
  return {
    assetId: attachment.assetId,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    byteSize: attachment.byteSize,
    sizeLabel: formatAttachmentSize(attachment.byteSize),
    isImage: INLINE_IMAGE_TYPES.has(attachment.mimeType.toLowerCase()),
    src: `collab-asset://doc/${encodeURIComponent(documentId)}/asset/${encodeURIComponent(attachment.assetId)}`,
    ...(attachment.width !== undefined ? { width: attachment.width } : {}),
    ...(attachment.height !== undefined ? { height: attachment.height } : {}),
  };
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseLegacyBody(text: string, ctx: ParseBodyContext): BodySegment[] {
  const refUrns = new Set(ctx.resourceRefs.map((ref) => resourceRefToUrn(ref)));
  const mentionedUsers = new Set(ctx.mentionedUserIds);
  const mentionedAgents = new Set(ctx.mentionedAgentSessionIds);

  const segments: BodySegment[] = [];
  let cursor = 0;

  const pushText = (text: string) => {
    if (text.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.type === 'text') last.text += text;
    else segments.push({ type: 'text', text });
  };

  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(text)) !== null) {
    const [raw, label, labeledUrn, bareUrn, code, strong, emphasis, shortcode] = match;
    pushText(text.slice(cursor, match.index));
    cursor = match.index + raw.length;

    const urn = labeledUrn ?? bareUrn;
    if (urn) {
      const resolved = resolveUrnSegment(urn, label, refUrns, mentionedUsers, mentionedAgents, ctx);
      if (resolved) segments.push(resolved);
      else pushText(raw);
      continue;
    }

    if (shortcode !== undefined) {
      const glyph = emojiGlyph(shortcode);
      if (glyph) segments.push({ type: 'emoji', shortcode, glyph });
      else pushText(raw);
      continue;
    }

    if (code !== undefined) segments.push({ type: 'code', text: code });
    else if (strong !== undefined) segments.push({ type: 'strong', text: strong });
    else if (emphasis !== undefined) segments.push({ type: 'emphasis', text: emphasis });
    else pushText(raw);
  }

  pushText(text.slice(cursor));
  return segments;
}

function parseEntityBody(body: RichCommentBody, ctx: ParseBodyContext): BodySegment[] {
  const segments: BodySegment[] = [];
  const utf16Offsets = utf8ByteOffsetsToUtf16(body.text);
  let cursor = 0;

  for (const entity of body.entities ?? []) {
    const start = utf16Offsets.get(entity.start)!;
    const end = utf16Offsets.get(entity.end)!;
    appendSegments(segments, parseInlineText(body.text.slice(cursor, start)));
    const resolved = resolveEntitySegment(entity, ctx);
    if (resolved) segments.push(resolved);
    else appendText(segments, body.text.slice(start, end));
    cursor = end;
  }

  appendSegments(segments, parseInlineText(body.text.slice(cursor)));
  return segments;
}

function parseInlineText(text: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let cursor = 0;

  INLINE_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_TOKEN.exec(text)) !== null) {
    const [raw, code, strong, emphasis, shortcode] = match;
    appendText(segments, text.slice(cursor, match.index));
    cursor = match.index + raw.length;

    if (shortcode !== undefined) {
      const glyph = emojiGlyph(shortcode);
      if (glyph) segments.push({ type: 'emoji', shortcode, glyph });
      else appendText(segments, raw);
    } else if (code !== undefined) segments.push({ type: 'code', text: code });
    else if (strong !== undefined) segments.push({ type: 'strong', text: strong });
    else if (emphasis !== undefined) segments.push({ type: 'emphasis', text: emphasis });
    else appendText(segments, raw);
  }

  appendText(segments, text.slice(cursor));
  return segments;
}

function resolveEntitySegment(entity: BodyEntity, ctx: ParseBodyContext): BodySegment | null {
  if (entity.kind === 'userMention') return userMentionSegment(entity.userId, undefined, ctx);
  if (entity.kind === 'agentMention') return agentMentionSegment(entity.sessionId, undefined, ctx);

  const ref = ctx.resourceRefs[entity.refIndex];
  if (!ref) return null;
  const pill = ctx.pills[resourceRefToUrn(ref)];
  return pill ? { type: 'resource', pill } : null;
}

function resolveUrnSegment(
  urn: string,
  label: string | undefined,
  refUrns: ReadonlySet<string>,
  mentionedUsers: ReadonlySet<string>,
  mentionedAgents: ReadonlySet<string>,
  ctx: ParseBodyContext,
): BodySegment | null {
  const userId = parseMentionUrn(urn);
  if (userId !== null) {
    if (!mentionedUsers.has(userId)) return null;
    return userMentionSegment(userId, label, ctx);
  }

  const sessionId = parseAgentMentionUrn(urn);
  if (sessionId !== null && mentionedAgents.has(sessionId)) {
    return agentMentionSegment(sessionId, label, ctx);
  }

  // Any other URN is a pill only if the message actually carries that ref.
  if (!refUrns.has(urn)) return null;
  const pill = ctx.pills[urn];
  if (!pill) return null;
  return { type: 'resource', pill };
}

function userMentionSegment(
  userId: string,
  label: string | undefined,
  ctx: ParseBodyContext,
): BodySegment {
  const person = ctx.directory.people.find((entry) => entry.userId === userId);
  const displayName = person?.displayName ?? ctx.directory.displayNames[userId] ?? label ?? 'Unknown member';
  return {
    type: 'mention',
    userId,
    displayName,
    initials: person?.avatarInitials ?? initialsFor(displayName),
    isViewer: userId === ctx.viewerUserId,
  };
}

function agentMentionSegment(
  sessionId: string,
  label: string | undefined,
  ctx: ParseBodyContext,
): BodySegment {
  const agent = ctx.directory.agents.find((entry) => entry.sessionId === sessionId);
  return {
    type: 'agentMention',
    sessionId,
    sessionName: agent?.sessionName ?? label ?? 'Agent session',
    ownerDisplayName: agent?.ownerDisplayName,
  };
}

function utf8ByteOffsetsToUtf16(text: string): ReadonlyMap<number, number> {
  const offsets = new Map<number, number>([[0, 0]]);
  let byteOffset = 0;
  let utf16Offset = 0;
  for (const character of text) {
    byteOffset += new TextEncoder().encode(character).byteLength;
    utf16Offset += character.length;
    offsets.set(byteOffset, utf16Offset);
  }
  return offsets;
}

function appendText(segments: BodySegment[], text: string): void {
  if (text.length === 0) return;
  const last = segments[segments.length - 1];
  if (last?.type === 'text') last.text += text;
  else segments.push({ type: 'text', text });
}

function appendSegments(segments: BodySegment[], additions: readonly BodySegment[]): void {
  for (const segment of additions) {
    if (segment.type === 'text') appendText(segments, segment.text);
    else segments.push(segment);
  }
}

export function initialsFor(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Plain-text projection, used for reply snippets and any place a body has to
 * collapse to one line. Pills and mentions collapse to their display label so a
 * snippet never contains a raw URN.
 */
export function segmentsToPlainText(segments: readonly BodySegment[]): string {
  return segments
    .map((segment) => {
      switch (segment.type) {
        case 'text':
        case 'code':
        case 'strong':
        case 'emphasis':
          return segment.text;
        case 'emoji':
          return segment.glyph;
        case 'mention':
          return `@${segment.displayName}`;
        case 'agentMention':
          return `@${segment.sessionName}`;
        case 'resource':
          return segment.pill.label;
        case 'attachments':
          // A message that is only a screenshot must not preview as nothing.
          return segment.attachments
            .map((attachment) => (attachment.isImage ? '[image]' : '[file]'))
            .join(' ');
        default:
          return '';
      }
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}
