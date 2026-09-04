/**
 * Turning a page of markdown prose into the two sets the comparison works over:
 * content tokens, and word k-shingles.
 *
 * Three normalisation choices carry weight:
 *
 * - **Stopwords go.** Two pages about the same decision share "the", "we" and
 *   "because" whether or not they agree, which floors Jaccard at a
 *   meaningless-but-nonzero value and compresses the range the thresholds live in.
 * - **URLs go, link text stays.** A citation link is metadata; the sentence
 *   around it is the memory. Keeping URLs makes two unrelated pages that both
 *   cite the same doc look similar.
 * - **Code contents stay.** A memory page often carries a snippet, and an
 *   identical snippet is among the strongest duplicate signals there is. Only
 *   the fence and backtick syntax is stripped.
 */

/**
 * Deliberately short. A long stopword list starts deleting the words that carry
 * the technical meaning ("no", "not", "own", "same" all appear on standard lists
 * and all flip the sense of an engineering note).
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'for', 'from', 'had',
  'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'of', 'on',
  'or', 'our', 'she', 'so', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'to', 'us', 'was', 'we', 'were', 'what', 'when', 'which', 'while',
  'will', 'with', 'would', 'you', 'your',
]);

/**
 * A crude suffix stripper, not a stemmer. It exists so "migrations" and
 * "migration", or "decided" and "decide", do not count as different evidence.
 * A real stemmer would be more accurate and would also be a dependency; this
 * module stays stdlib-only on purpose.
 */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** Strip markdown syntax and URLs, leaving the words. */
export function normalizeProse(text: string): string {
  return text
    .replace(/```[a-z0-9+#-]*\n?/gi, ' ') // fence markers, not fence contents
    .replace(/`+/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, ' $1 ') // keep link text, drop the target
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/^[ \t]*[#>]+[ \t]*/gm, ' ')
    .replace(/^[ \t]*[-*+][ \t]+/gm, ' ')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .trim();
}

/** Content tokens: normalized, stopword-filtered, crudely stemmed. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeProse(text).split(' ')) {
    if (!raw || raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** Overlapping word k-shingles, as a set. */
export function shingle(tokens: readonly string[], k: number): Set<string> {
  const set = new Set<string>();
  if (tokens.length === 0) return set;
  if (tokens.length < k) {
    set.add(tokens.join(' '));
    return set;
  }
  for (let i = 0; i + k <= tokens.length; i += 1) {
    set.add(tokens.slice(i, i + k).join(' '));
  }
  return set;
}

/** Everything the comparison needs from one page, computed once. */
export interface TextProfile {
  tokens: Set<string>;
  shingles: Set<string>;
  /** Distinct content tokens; the length measure the ratios use. */
  size: number;
}

export function profileText(text: string, shingleSize = 3): TextProfile {
  const tokens = tokenize(text);
  return {
    tokens: new Set(tokens),
    shingles: shingle(tokens, shingleSize),
    size: new Set(tokens).size,
  };
}

/** |a ∩ b| for two sets, iterating the smaller one. */
export function intersectionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const value of small) if (large.has(value)) n += 1;
  return n;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const shared = intersectionSize(a, b);
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}
