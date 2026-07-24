/**
 * Auto-distillation helpers (Phase 5).
 *
 * Pure logic for turning recent project docs (decisions/plans) into CANDIDATE
 * durable facts the user confirms before they are stored. mem0-style: a single
 * extraction pass, ADD-only (we never mutate/delete existing facts here), and
 * contradictions resolve at retrieval by recency. The actual LLM call + source
 * selection live in `src/backend.ts` (Nimbalyst-facing); these pieces are pure
 * so they're unit-testable and stay out of the host-agnostic `engine/`.
 */

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface DistillDoc {
  path: string;
  content: string;
}

export interface FactCandidate {
  text: string;
  category: string | null;
  scope: string | null;
  /** The doc this candidate was distilled from, when known. */
  sourcePath?: string;
}

const MAX_FACT_LEN = 300;
const DEFAULT_DOC_CHARS = 4000;

const SYSTEM_PROMPT =
  'You distill durable project knowledge into short, standalone facts. From the ' +
  'provided document excerpts, extract the salient DECISIONS, preferences, ' +
  'constraints, and durable truths worth remembering for future conversations. ' +
  'Rules: each fact is one self-contained sentence understandable without the ' +
  'source; prefer decisions and rules over transient status; skip anything ' +
  'speculative or already obvious. Respond with ONLY a JSON array of objects ' +
  '{ "text": string, "category"?: string, "scope"?: string } and nothing else. ' +
  'Return an empty array if there is nothing durable.';

/** Build the chat messages for the extraction call. */
export function buildDistillMessages(
  docs: DistillDoc[],
  maxCharsPerDoc = DEFAULT_DOC_CHARS
): ChatMessage[] {
  const sections = docs.map((d) => {
    const excerpt = d.content.slice(0, Math.max(0, maxCharsPerDoc));
    return `### ${d.path}\n${excerpt}`;
  });
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        'Extract durable facts from these documents:\n\n' + sections.join('\n\n'),
    },
  ];
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function toStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Pull the first JSON value (array or object) out of a model response. */
function extractJson(text: string): unknown {
  let s = text.trim();
  // Strip a leading/trailing code fence if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Find the first array or object.
  const start = s.search(/[[{]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === '[' ? ']' : '}';
  const end = s.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Parse a model response into deduped fact candidates. `existing` are the texts
 * of facts already stored (so we don't propose duplicates). Never throws —
 * malformed output yields `[]`.
 */
export function parseDistillResponse(
  modelText: string,
  existing: string[]
): FactCandidate[] {
  const parsed = extractJson(modelText);
  let items: unknown[] = [];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const arr = obj.facts ?? obj.candidates ?? obj.items;
    if (Array.isArray(arr)) items = arr;
  }

  const seen = new Set(existing.map(normalize));
  const out: FactCandidate[] = [];
  for (const item of items) {
    let text: string | null = null;
    let category: string | null = null;
    let scope: string | null = null;
    if (typeof item === 'string') {
      text = toStr(item);
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      text = toStr(o.text ?? o.fact);
      category = toStr(o.category);
      scope = toStr(o.scope);
    }
    if (!text) continue;
    if (text.length > MAX_FACT_LEN) continue;
    const key = normalize(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, category, scope });
  }
  return out;
}
