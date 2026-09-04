/**
 * Render a memory as a `.claude/rules/*.md` file a human would have written.
 *
 * The house style of that directory is consistent and it is the whole product:
 * a short imperative `##` title, the rule stated plainly, and why it exists —
 * usually the incident that caused it. Optional frontmatter scopes the rule to
 * globs and pulls in the long-form doc. A promoted rule that reads like a
 * serialized database row defeats the point of promoting it, because the value
 * of this path is that a reviewer *reads* a new rule file, where they would
 * skim "+3 memories" in a data file and move on.
 *
 * Everything here is a pure function from the input shape to file bytes. The
 * caller writes them only after showing them to a person.
 */
import {
  DEFAULT_TRACKER_KEY_PREFIXES,
  assertNoTrackerKeys,
  formatIssueCitation,
  stripTrackerKeys,
} from './provenance.js';
import type { PromotionSignal } from './signal.js';
import type { PromotableMemory } from './types.js';

export interface RenderRuleOptions {
  /** Injected so the provenance line is deterministic in tests. */
  now?: Date;
  trackerKeyPrefixes?: readonly string[];
  /** When present, its headline becomes the evidence in the provenance line. */
  signal?: PromotionSignal;
}

export interface RenderedRule {
  /** Kebab-case file name, e.g. `never-read-api-keys-from-the-environment.md`. */
  fileName: string;
  /** The complete file, ending in exactly one newline. */
  contents: string;
  /** Things the reviewer has to look at before committing. */
  warnings: string[];
}

/** Quote a YAML scalar only where the spec needs it, matching the existing files. */
function yamlScalar(value: string): string {
  const needsQuotes =
    value === '' ||
    /^[*&!|>%@`?:,[\]{}#-]/.test(value) ||
    /:\s|\s#|["']/.test(value) ||
    value !== value.trim();
  return needsQuotes ? JSON.stringify(value) : value;
}

function yamlList(key: string, values: readonly string[]): string[] {
  return [`${key}:`, ...values.map((value) => `  - ${yamlScalar(value)}`)];
}

/**
 * Title to file name. Rejects rather than guesses when nothing usable survives:
 * a file called `rule.md` in `.claude/rules` tells a reader nothing and is the
 * kind of name that gets promoted twice.
 */
export function ruleFileNameFor(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[`_*]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  if (!slug) {
    throw new Error(`Cannot derive a rule file name from title: ${JSON.stringify(title)}`);
  }
  return `${slug}.md`;
}

const ISO_DATE = (date: Date): string => date.toISOString().slice(0, 10);

export function renderRuleMarkdown(
  memory: PromotableMemory,
  options: RenderRuleOptions = {},
): RenderedRule {
  const prefixes = options.trackerKeyPrefixes ?? DEFAULT_TRACKER_KEY_PREFIXES;
  const warnings: string[] = [];

  const clean = (text: string | undefined): string => {
    if (!text) return '';
    const { text: stripped, removals } = stripTrackerKeys(text, prefixes);
    for (const removal of removals) {
      warnings.push(
        `Removed tracker key ${removal.key} — it resolves to an unrelated item outside this ` +
          `workspace. Cite a GitHub issue or state the reason in prose: "${removal.context}"`,
      );
    }
    return stripped.trim();
  };

  const title = clean(memory.title).replace(/^#+\s*/, '').replace(/\s+/g, ' ');
  if (!title) {
    throw new Error('Cannot promote a memory with no title.');
  }
  const body = clean(memory.body);
  if (!body) {
    throw new Error('Cannot promote a memory with no body — there is no rule to state.');
  }

  const lines: string[] = [];

  const globs = (memory.appliesTo ?? []).map((glob) => glob.trim()).filter(Boolean);
  const docs = (memory.relatedDocs ?? []).map((doc) => doc.trim()).filter(Boolean);
  if (globs.length > 0 || docs.length > 0) {
    lines.push('---');
    if (globs.length > 0) lines.push(...yamlList('globs', globs));
    if (docs.length > 0) lines.push(...yamlList('imports', docs));
    lines.push('---', '');
  }

  lines.push(`## ${title}`, '', body, '');

  const citation = formatIssueCitation(memory.githubIssues ?? []);
  const why = clean(memory.why);
  const sourceNote = clean(memory.sourceNote);
  const whyParagraphs: string[] = [];
  if (citation) {
    whyParagraphs.push(`This rule exists because of ${citation}.`);
  }
  if (why) {
    whyParagraphs.push(why);
  } else if (!citation && sourceNote) {
    whyParagraphs.push(sourceNote);
  }
  if (whyParagraphs.length > 0) {
    lines.push('### Why this rule exists', '');
    // A citation and a short reason read as one paragraph, the way the existing
    // rules are written; a long reason gets its own.
    const merged =
      whyParagraphs.length === 2 && whyParagraphs[1].length < 240
        ? [`${whyParagraphs[0]} ${whyParagraphs[1]}`]
        : whyParagraphs;
    for (const paragraph of merged) {
      lines.push(paragraph, '');
    }
  }
  if (!citation && !why && !sourceNote) {
    warnings.push(
      'No GitHub issue or source note, so the file does not say why the rule exists. ' +
        'Rules without a reason are the ones that get deleted by the next person.',
    );
  }

  lines.push(provenanceLine(memory, options), '');

  // No blank-line normalisation pass over the joined result: every section
  // above contributes exactly one separator, and a global collapse would
  // rewrite whatever the body itself contains, including fenced code.
  const contents = `${lines.join('\n').trimEnd()}\n`;
  assertNoTrackerKeys(contents, prefixes);

  return { fileName: ruleFileNameFor(title), contents, warnings };
}

/**
 * One italic line so a reader can tell this was promoted rather than authored,
 * and see the evidence it was promoted on. No record id: see `provenance.ts`.
 */
function provenanceLine(memory: PromotableMemory, options: RenderRuleOptions): string {
  const date = ISO_DATE(options.now ?? new Date());
  const evidence = options.signal?.headline?.trim();
  // The headline is written to stand alone; here it is a clause, so it loses
  // its capital and its full stop.
  const clause = evidence
    ? `${evidence.charAt(0).toLowerCase()}${evidence.slice(1)}`.replace(/\.$/, '')
    : '';
  const suffix = clause ? ` — ${clause}` : '';
  return `*Promoted from Nimbalyst project memory on ${date}${suffix}.*`;
}
