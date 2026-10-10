// @vitest-environment node
/**
 * The tree matcher must refuse a diff it cannot afford (#4821).
 *
 * `pairCost` / `alignChildren` allocate an m*n matrix and memoize a cost per
 * cell for every pair of siblings they align. A 194KB markdown file with a few
 * thousand top-level blocks on each side pushed that memo past V8's ~16.7M
 * `Map` entry cap: the renderer main thread blocked for ~31s and then threw
 * "Map maximum size exceeded", so the user paid the whole freeze for no diff.
 */
import {describe, expect, it} from 'vitest';

import {$getRoot, type SerializedLexicalNode} from 'lexical';

import {DiffExtension} from '../../../../../extensions/builtin/DiffExtension';
import {$convertFromEnhancedMarkdownString} from '../../../../../markdown';
import {APPLY_MARKDOWN_REPLACE_COMMAND, type ApplyMarkdownReplaceResult} from '../../../DiffCommands';
import {createTestHeadlessEditor, MARKDOWN_TEST_TRANSFORMERS} from '../../utils/testConfig';

import type {CanonicalTreeNode} from '../../../core/canonicalTree';
import {
  DEFAULT_MAX_PAIR_EVALUATIONS,
  DiffBudgetExceededError,
  diffTrees,
} from '../../../core/ThresholdedOrderPreservingTree';

let nextId = 0;

function para(text: string): CanonicalTreeNode {
  const id = nextId++;
  return {
    id,
    key: `k${id}`,
    type: 'paragraph',
    text,
    children: [],
    serialized: {type: 'paragraph', version: 1} as SerializedLexicalNode,
  };
}

function element(type: string, children: CanonicalTreeNode[], text = ''): CanonicalTreeNode {
  const id = nextId++;
  return {
    id,
    key: `k${id}`,
    type,
    text,
    children,
    serialized: {type, version: 1} as SerializedLexicalNode,
  };
}

function textNode(text: string): CanonicalTreeNode {
  return element('text', [], text);
}

function bullet(text: string): CanonicalTreeNode {
  return element('listitem', [textNode(text)], text);
}

/**
 * The shape of a bullet-heavy plan: headings, a paragraph, and a list of long
 * bullets per section. Built fresh per call so source and target share no ids.
 */
function planDoc(sections: number, edit?: {section: number; item: number; text: string}): CanonicalTreeNode {
  const children: CanonicalTreeNode[] = [];
  for (let s = 0; s < sections; s++) {
    children.push(element('heading', [textNode(`Section ${s}`)], `Section ${s}`));
    children.push(para(`Overview of section ${s} and the reasoning behind its phases and exit criteria.`));
    const items: CanonicalTreeNode[] = [];
    for (let i = 0; i < 8; i++) {
      const text = edit && edit.section === s && edit.item === i
        ? edit.text
        : `Item ${i} of section ${s}: the scope includes resolving references across workspaces, ` +
          `recording provenance for every derived fact, and keeping the index rebuildable from source files.`;
      items.push(bullet(text));
    }
    children.push(element('list', items));
  }
  return root(children);
}

function root(children: CanonicalTreeNode[]): CanonicalTreeNode {
  const id = nextId++;
  return {
    id,
    key: `root${id}`,
    type: 'root',
    children,
    serialized: {type: 'root', version: 1} as SerializedLexicalNode,
  };
}

describe('diffTrees pair budget', () => {
  it('refuses an over-budget alignment instead of exhausting the memo', () => {
    // 4200x4200 is ~17.6M cells -- just past the V8 Map cap that produced the
    // original crash, and ~9x the default budget.
    const source = root(Array.from({length: 4200}, (_, i) => para(`source line ${i}`)));
    const target = root(Array.from({length: 4200}, (_, i) => para(`target line ${i}`)));

    const started = Date.now();
    let thrown: unknown;
    try {
      diffTrees(source, target);
    } catch (error) {
      thrown = error;
    }
    const elapsedMs = Date.now() - started;

    expect(thrown).toBeInstanceOf(DiffBudgetExceededError);
    expect((thrown as DiffBudgetExceededError).budget).toBe(DEFAULT_MAX_PAIR_EVALUATIONS);
    // The whole point is that the bail is O(1): it must happen before the
    // matrix is allocated, not after minutes of work.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('still diffs a document that fits inside the budget', () => {
    const source = root([para('alpha'), para('beta'), para('gamma')]);
    const target = root([para('alpha'), para('wholly unrelated wording'), para('gamma')]);

    const ops = diffTrees(source, target);

    const leafOps = ops.filter(
      (op) =>
        ('aPath' in op && op.aPath.length === 1) || ('bPath' in op && op.bPath.length === 1),
    );
    expect(leafOps.map((op) => op.op)).toEqual(['equal', 'replace', 'equal']);
  });

  it('does not pay for unchanged blocks when one bullet in a long plan changes', () => {
    // A 121KB plan of ~200 root blocks (most of them lists of long bullets)
    // spent the full 2M-cell budget -- a 6.3s renderer freeze -- because every
    // list was aligned against every other list. Only the edited region should
    // cost anything, so a budget a few hundred times smaller must still fit.
    const source = planDoc(60);
    const target = planDoc(60, {section: 30, item: 4, text: 'Item 4 was rewritten by the agent.'});

    const ops = diffTrees(source, target, {maxPairEvaluations: 5_000});

    const changed = ops.filter((op) => op.op !== 'equal');
    const changedText = changed.map((op) => ('b' in op ? op.b.text : op.a.text));
    expect(changedText).toContain('Item 4 was rewritten by the agent.');
    // Everything that changed is inside the edited section's list.
    const editedList = 30 * 3 + 2;
    expect(new Set(changed.map((op) => ('bPath' in op ? op.bPath : op.aPath)[0]))).toEqual(new Set([editedList]));
  });

  it('keeps an edit that touches every bullet fast and aligned in place (#1606)', () => {
    // Renumbering a `**#N**` label on every bullet leaves no identical edges
    // to trim, and with the root matcher's permissive threshold every list is
    // "alignable" with every other list. Each list pair then aligned every
    // item's inline runs against every other item's: ~5s here, ~25s on the
    // reporter's machine. Pairs that cannot beat delete/insert are now skipped
    // by a lower bound, without changing the result.
    const words = (seed: number, n: number) => {
      let x = seed;
      return Array.from({length: n}, () => {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0;
        return VOCAB[x % VOCAB.length];
      }).join(' ');
    };
    const labelledDoc = (labelOffset: number) => {
      const children: CanonicalTreeNode[] = [];
      let n = 0;
      for (let s = 0; s < 8; s++) {
        children.push(element('heading', [textNode(`Section ${s}`)], `Section ${s}`));
        const items = Array.from({length: 30}, () => {
          n++;
          const runs = [
            textNode(`**#${n + labelOffset}** ${words(n * 3 + 1, 12)}`),
            element('link', [textNode('provenance')], 'provenance'),
            textNode(words(n * 3 + 2, 14)),
            element('link', [textNode('from source')], 'from source'),
            textNode(words(n * 3 + 3, 8)),
          ];
          return element('listitem', runs, runs.map((r) => r.text).join(' '));
        });
        children.push(element('list', items, items.map((item) => item.text).join('\n')));
      }
      return root(children);
    };

    const started = Date.now();
    const ops = diffTrees(labelledDoc(0), labelledDoc(1), ROOT_MATCHER_OPTS);
    const elapsedMs = Date.now() - started;

    const changedItems = ops.filter((op) => op.op !== 'equal' && 'aPath' in op && op.aPath.length === 2);
    expect(changedItems).toHaveLength(8 * 30);
    for (const op of changedItems) {
      expect(op.op).toBe('replace');
      expect((op as {bPath: number[]}).bPath).toEqual((op as {aPath: number[]}).aPath);
    }
    expect(elapsedMs).toBeLessThan(2000);
  });
});

const VOCAB = 'scope index resolve workspace reference derived fact provenance source rebuild rescan ontology claim finding label graph wiki page entity predicate schema tracker sync room'.split(' ');

/** The options `TreeMatcher.matchCanonicalNodes` runs the root diff with. */
const ROOT_MATCHER_OPTS = {
  pairAlignThreshold: 2.0,
  equalThreshold: 0.1,
  wText: 3.0,
  wAttr: 0.15,
  wStruct: 0.35,
  isTextual: (n: CanonicalTreeNode) => ['text', 'paragraph', 'heading', 'list', 'listitem'].includes(n.type),
};

describe('APPLY_MARKDOWN_REPLACE_COMMAND size refusal', () => {
  it('reports DIFF_TOO_LARGE to the caller instead of only swallowing it', () => {
    // Lexical swallows a command listener's throw. Before `onResult`, TabEditor
    // saw only "no diff nodes", reported `failed`, and the model reloaded and
    // replayed the same multi-second diff three times per registration.
    const editor = createTestHeadlessEditor();
    const unregister = (DiffExtension.register as unknown as (e: typeof editor) => () => void)(editor);
    const lines = (prefix: string) =>
      Array.from({length: 1500}, (_, i) => `${prefix} paragraph ${i}`).join('\n\n');
    editor.update(() => {
      $getRoot().clear();
      $convertFromEnhancedMarkdownString(lines('source'), MARKDOWN_TEST_TRANSFORMERS);
    }, {discrete: true});

    let result: ApplyMarkdownReplaceResult | null = null;
    editor.dispatchCommand(APPLY_MARKDOWN_REPLACE_COMMAND, {
      replacements: [{newText: lines('target')}],
      onResult: (r) => { result = r; },
    });
    unregister();

    expect(result).toMatchObject({ok: false, errorType: 'DIFF_TOO_LARGE'});
  });
});
