/**
 * Shortcode emoji catalog.
 *
 * `ReactionAggregate.emoji` is documented as a shortcode, so shortcodes are the
 * stored form everywhere: reactions store `+1`, bodies store `:+1:`, and the
 * glyph is a rendering detail resolved here. That keeps a reaction key stable
 * if the glyph table ever changes, and keeps bodies byte-cheap against
 * MAX_RICH_COMMENT_TEXT_BYTES.
 *
 * Deliberately small and hand-picked rather than a full Unicode table: this is
 * the ack-and-acknowledge vocabulary the plan calls for, and a 1800-entry
 * catalog would dominate the renderer bundle for no product gain. Unknown
 * shortcodes render as literal text, never as a broken glyph.
 */

export interface EmojiEntry {
  shortcode: string;
  glyph: string;
  keywords: string[];
  group: 'reactions' | 'people' | 'objects' | 'symbols';
}

export const EMOJI_CATALOG: readonly EmojiEntry[] = [
  { shortcode: '+1', glyph: '\u{1F44D}', keywords: ['thumbsup', 'yes', 'approve', 'lgtm'], group: 'reactions' },
  { shortcode: '-1', glyph: '\u{1F44E}', keywords: ['thumbsdown', 'no'], group: 'reactions' },
  { shortcode: 'eyes', glyph: '\u{1F440}', keywords: ['looking', 'review'], group: 'reactions' },
  { shortcode: 'white_check_mark', glyph: '✅', keywords: ['done', 'check', 'ack'], group: 'reactions' },
  { shortcode: 'tada', glyph: '\u{1F389}', keywords: ['celebrate', 'ship'], group: 'reactions' },
  { shortcode: 'rocket', glyph: '\u{1F680}', keywords: ['ship', 'deploy', 'launch'], group: 'reactions' },
  { shortcode: 'fire', glyph: '\u{1F525}', keywords: ['hot', 'urgent'], group: 'reactions' },
  { shortcode: 'heart', glyph: '❤️', keywords: ['love', 'thanks'], group: 'reactions' },
  { shortcode: 'pray', glyph: '\u{1F64F}', keywords: ['thanks', 'please'], group: 'people' },
  { shortcode: 'wave', glyph: '\u{1F44B}', keywords: ['hello', 'hi'], group: 'people' },
  { shortcode: 'thinking_face', glyph: '\u{1F914}', keywords: ['hmm', 'unsure'], group: 'people' },
  { shortcode: 'smile', glyph: '\u{1F604}', keywords: ['happy', 'grin'], group: 'people' },
  { shortcode: 'sweat_smile', glyph: '\u{1F605}', keywords: ['nervous', 'phew'], group: 'people' },
  { shortcode: 'cry', glyph: '\u{1F622}', keywords: ['sad', 'tears'], group: 'people' },
  { shortcode: 'raised_hands', glyph: '\u{1F64C}', keywords: ['celebrate', 'praise'], group: 'people' },
  { shortcode: 'clap', glyph: '\u{1F44F}', keywords: ['applause', 'nice'], group: 'people' },
  { shortcode: 'bug', glyph: '\u{1F41B}', keywords: ['defect', 'issue'], group: 'objects' },
  { shortcode: 'bulb', glyph: '\u{1F4A1}', keywords: ['idea', 'suggestion'], group: 'objects' },
  { shortcode: 'memo', glyph: '\u{1F4DD}', keywords: ['note', 'doc', 'write'], group: 'objects' },
  { shortcode: 'mag', glyph: '\u{1F50D}', keywords: ['search', 'investigate'], group: 'objects' },
  { shortcode: 'hammer_and_wrench', glyph: '\u{1F6E0}️', keywords: ['fix', 'build', 'tools'], group: 'objects' },
  { shortcode: 'robot_face', glyph: '\u{1F916}', keywords: ['agent', 'bot', 'session'], group: 'objects' },
  { shortcode: 'hourglass', glyph: '⏳', keywords: ['waiting', 'pending'], group: 'objects' },
  { shortcode: 'lock', glyph: '\u{1F512}', keywords: ['private', 'secure'], group: 'objects' },
  { shortcode: 'warning', glyph: '⚠️', keywords: ['caution', 'risk'], group: 'symbols' },
  { shortcode: 'x', glyph: '❌', keywords: ['no', 'fail', 'reject'], group: 'symbols' },
  { shortcode: 'question', glyph: '❓', keywords: ['ask', 'unclear'], group: 'symbols' },
  { shortcode: 'exclamation', glyph: '❗', keywords: ['important'], group: 'symbols' },
  { shortcode: 'arrow_right', glyph: '➡️', keywords: ['next', 'then'], group: 'symbols' },
  { shortcode: 'recycle', glyph: '♻️', keywords: ['refactor', 'reuse'], group: 'symbols' },
];

const BY_SHORTCODE = new Map(EMOJI_CATALOG.map((entry) => [entry.shortcode, entry]));

/** Reaction picker default row; the same shortcodes the plan calls acks. */
export const QUICK_REACTIONS: readonly string[] = [
  '+1',
  'eyes',
  'white_check_mark',
  'tada',
  'rocket',
  'heart',
];

export function emojiGlyph(shortcode: string): string | undefined {
  return BY_SHORTCODE.get(shortcode)?.glyph;
}

/** Glyph if known, otherwise the shortcode spelled back out. Never blank. */
export function emojiGlyphOrShortcode(shortcode: string): string {
  return BY_SHORTCODE.get(shortcode)?.glyph ?? `:${shortcode}:`;
}

/**
 * `:shortcode:` autocomplete. Matches a prefix of the shortcode first, then
 * keywords, so typing `:sh` puts `ship`-ish results ahead of incidental
 * keyword hits.
 */
export function searchEmoji(query: string, limit = 8): EmojiEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return EMOJI_CATALOG.slice(0, limit);

  const prefix: EmojiEntry[] = [];
  const contains: EmojiEntry[] = [];
  const keyword: EmojiEntry[] = [];

  for (const entry of EMOJI_CATALOG) {
    if (entry.shortcode.startsWith(needle)) prefix.push(entry);
    else if (entry.shortcode.includes(needle)) contains.push(entry);
    else if (entry.keywords.some((word) => word.startsWith(needle))) keyword.push(entry);
  }

  return [...prefix, ...contains, ...keyword].slice(0, limit);
}
