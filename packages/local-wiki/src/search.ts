import type { LocalSearchHit } from './types.js';

export interface SearchDoc {
  id: string;
  title: string;
  kind: 'page' | 'row';
  type: string | null;
  path: string | null;
  body: string;
  fields: Record<string, unknown>;
}

function fieldText(fields: Record<string, unknown>): string {
  return Object.values(fields)
    .map((v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)))
    .join(' ');
}

function snippetAround(text: string, term: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(term);
  if (at < 0) return flat.slice(0, 120);
  const start = Math.max(0, at - 50);
  const end = Math.min(flat.length, at + term.length + 70);
  return (start > 0 ? '...' : '') + flat.slice(start, end) + (end < flat.length ? '...' : '');
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0 && count < 20; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

/**
 * Every whitespace-separated term must appear in the title, body or field
 * values (case-insensitive). Title hits rank above body hits.
 */
export function searchDocs(docs: Iterable<SearchDoc>, query: string, limit: number): LocalSearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const hits: LocalSearchHit[] = [];
  for (const doc of docs) {
    const title = doc.title.toLowerCase();
    const rest = `${doc.body}\n${fieldText(doc.fields)}`;
    const restLower = rest.toLowerCase();
    let score = 0;
    let matched = true;
    for (const term of terms) {
      const inTitle = title.includes(term);
      const inRest = countOccurrences(restLower, term);
      if (!inTitle && inRest === 0) {
        matched = false;
        break;
      }
      score += (inTitle ? 10 : 0) + inRest;
    }
    if (!matched) continue;
    hits.push({
      id: doc.id,
      title: doc.title,
      kind: doc.kind,
      type: doc.type,
      path: doc.path,
      snippet: snippetAround(rest, terms.find((t) => restLower.includes(t)) ?? terms[0]),
      score,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return hits.slice(0, limit);
}
