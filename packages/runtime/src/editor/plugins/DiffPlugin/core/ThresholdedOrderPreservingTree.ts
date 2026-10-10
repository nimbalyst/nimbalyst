import type {CanonicalTreeNode} from './canonicalTree';
import {LcsPattern} from './textDistance';
import {isDiffDebug} from './diffDebug';

type Path = number[];

export type DiffOp =
    | { op: 'equal'; aPath: Path; bPath: Path; a: CanonicalTreeNode; b: CanonicalTreeNode }
    | { op: 'insert'; bPath: Path; b: CanonicalTreeNode }
    | { op: 'delete'; aPath: Path; a: CanonicalTreeNode }
    | { op: 'replace'; aPath: Path; bPath: Path; a: CanonicalTreeNode; b: CanonicalTreeNode };

/**
 * Cap on the number of (source child, target child) cells this diff may
 * evaluate. Every `pairCost` / `alignChildren` call allocates an m*n cost
 * matrix and memoizes an entry per cell, so the work and the memory are both
 * quadratic in sibling count. Without a cap, a document with a few thousand
 * blocks on each side crosses V8's ~16.7M `Map` entry limit and the whole
 * thing dies with "Map maximum size exceeded" -- after ~31s of a frozen
 * renderer main thread, with no diff to show for it (#4821).
 *
 * 2M cells is ~8x below the V8 cap. Measured on a paragraph-per-block corpus:
 * 160k cells ~0.5s, 640k ~2.4s, 1.96M ~6.4s -- so this bounds the worst case
 * at a few seconds rather than half a minute, and it is a last-resort net, not
 * a UX target. Callers that can bail more gracefully (see the root-node guard
 * in TabEditor) should do so well before reaching this ceiling.
 */
export const DEFAULT_MAX_PAIR_EVALUATIONS = 2_000_000;

/**
 * Thrown when a diff would exceed {@link DiffOpts.maxPairEvaluations}. Callers
 * are expected to catch this and fall back to a non-structural presentation
 * rather than let it surface as an opaque runtime error.
 */
export class DiffBudgetExceededError extends Error {
    readonly sourceChildCount: number;
    readonly targetChildCount: number;
    readonly budget: number;

    constructor(sourceChildCount: number, targetChildCount: number, budget: number) {
        super(
            `Tree diff exceeded its pair budget: aligning ${sourceChildCount} source ` +
            `against ${targetChildCount} target children needs ` +
            `${sourceChildCount * targetChildCount} cells, budget is ${budget}`,
        );
        this.name = 'DiffBudgetExceededError';
        this.sourceChildCount = sourceChildCount;
        this.targetChildCount = targetChildCount;
        this.budget = budget;
    }
}

/**
 * Charges m*n before each alignment matrix is allocated, so an over-budget
 * pair throws in O(1) instead of after the allocation it cannot afford.
 */
class PairBudget {
    private used = 0;

    constructor(private readonly limit: number) {}

    charge(m: number, n: number): void {
        const cells = m * n;
        if (cells > this.limit - this.used) {
            throw new DiffBudgetExceededError(m, n, this.limit);
        }
        this.used += cells;
    }
}

type PairContext = {
    memo: Map<PairKey, number>;
    budget: PairBudget;
    signatures: WeakMap<CanonicalTreeNode, number>;
    signatureIds: Map<string, number>;
    tokens: WeakMap<CanonicalTreeNode, string[]>;
    patterns: WeakMap<CanonicalTreeNode, LcsPattern<string>>;
};

/**
 * Everything `pairCost` reads from a subtree -- type, text, attrs, children --
 * interned to an id, so two nodes with the same id always cost 0 against each
 * other. The key embeds child ids, never child keys: nesting the child strings
 * re-escapes them at every level, and on ten levels of nested lists that grew
 * exponentially (134ms -> 8.7s).
 */
function signature(n: CanonicalTreeNode, ctx: PairContext): number {
    const cached = ctx.signatures.get(n);
    if (cached !== undefined) return cached;
    const childIds = kids(n).map((c) => signature(c, ctx));
    const key = JSON.stringify([n.type, n.text ?? '', n.attrs ?? null, childIds]);
    let id = ctx.signatureIds.get(key);
    if (id === undefined) {
        id = ctx.signatureIds.size;
        ctx.signatureIds.set(key, id);
    }
    ctx.signatures.set(n, id);
    return id;
}

function sameSubtree(a: CanonicalTreeNode, b: CanonicalTreeNode, ctx: PairContext): boolean {
    return a === b || signature(a, ctx) === signature(b, ctx);
}

/**
 * Leading and trailing children that are identical on both sides. An agent edit
 * usually touches a few blocks of a long document, and aligning the unchanged
 * ones all-pairs is what froze the renderer for ~6s on a ~200-block plan: every
 * list was costed against every other list, recursively. Identical runs at the
 * edges are matched in place, so only the changed middle pays for the DP.
 */
function identicalEdges(A: CanonicalTreeNode[], B: CanonicalTreeNode[], ctx: PairContext): { pre: number; suf: number } {
    const max = Math.min(A.length, B.length);
    let pre = 0;
    while (pre < max && sameSubtree(A[pre], B[pre], ctx)) pre++;
    let suf = 0;
    while (suf < max - pre && sameSubtree(A[A.length - 1 - suf], B[B.length - 1 - suf], ctx)) suf++;
    return { pre, suf };
}

export type DiffOpts = {
    // node-pairing
    allowTypePair?: (aType: string, bType: string) => boolean;
    // used to *allow* pairing two children during alignment
    pairAlignThreshold: number;         // lower = stricter "same node" check
    // used to mark a matched pair as "equal" (unchanged) vs "replace"
    equalThreshold: number;

    // cost weights
    delCostPerNode: number;
    typePenalty: number;                // applied when types differ but allowed
    wText: number;
    wAttr: number;
    wStruct: number;

    // text similarity
    isTextual?: (n: CanonicalTreeNode) => boolean;

    // safety
    maxPairEvaluations: number;         // see DEFAULT_MAX_PAIR_EVALUATIONS
};

const DFLT: DiffOpts = {
    allowTypePair: (a, b) => a === b || (a === 'paragraph' && b === 'paragraph'),
    pairAlignThreshold: 0.9,  // only very-similar subtrees are allowed to align
    equalThreshold: 0.35,
    delCostPerNode: 1,
    typePenalty: 0.4,
    wText: 0.5,
    wAttr: 0.15,
    wStruct: 0.35,
    isTextual: (n) => n.type === 'text' || n.type === 'paragraph',
    maxPairEvaluations: DEFAULT_MAX_PAIR_EVALUATIONS,
};

const kids = (n?: CanonicalTreeNode) => n?.children ?? [];

function subtreeSize(n: CanonicalTreeNode): number {
    let s = 1;
    for (const c of kids(n)) s += subtreeSize(c);
    return s;
}

function delCost(n: CanonicalTreeNode, opts: DiffOpts): number {
    return subtreeSize(n) * opts.delCostPerNode;
}

function tok(s = ''): string[] { return s.trim() ? s.trim().split(/\s+/) : []; }
/**
 * A node is compared against every candidate sibling, so its tokens (and, on
 * the source side, its LCS match masks) are built once per diff.
 */
function tokens(n: CanonicalTreeNode, ctx: PairContext): string[] {
    let cached = ctx.tokens.get(n);
    if (!cached) { cached = tok(n.text); ctx.tokens.set(n, cached); }
    return cached;
}
function textSim(a: CanonicalTreeNode, b: CanonicalTreeNode, ctx: PairContext): number {
    const A = tokens(a, ctx), B = tokens(b, ctx);
    if (!A.length && !B.length) return 1;
    if (!A.length || !B.length) return 0;
    let pattern = ctx.patterns.get(a);
    if (!pattern) { pattern = new LcsPattern(A); ctx.patterns.set(a, pattern); }
    return pattern.lcsWith(B) / Math.max(A.length, B.length);
}
function attrDist(a?: Record<string, any>, b?: Record<string, any>) {
    if (!a && !b) return 0;
    if (!a || !b) return 1;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let d = 0; for (const k of keys) if (a[k] !== b[k]) d++;
    return keys.size ? d / keys.size : 0;
}

// Check if a node is empty (paragraph with no text content)
function isEmptyNode(n: CanonicalTreeNode): boolean {
    return n.type === 'paragraph' && (!n.text || n.text.trim() === '');
}

// Compute contextual similarity for empty nodes based on surrounding non-empty anchors
// An empty paragraph should prefer matching another empty paragraph in similar context
function contextualSimilarity(
    aNode: CanonicalTreeNode,
    bNode: CanonicalTreeNode,
    aIndex: number,
    bIndex: number,
    aSiblings: CanonicalTreeNode[],
    bSiblings: CanonicalTreeNode[]
): number {
    // Only applies to empty nodes
    if (!isEmptyNode(aNode) || !isEmptyNode(bNode)) {
        return 0; // No contextual bonus
    }

    let score = 0;
    let contextCount = 0;

    // Look at previous non-empty sibling
    let aPrev: CanonicalTreeNode | null = null;
    for (let i = aIndex - 1; i >= 0; i--) {
        if (!isEmptyNode(aSiblings[i])) {
            aPrev = aSiblings[i];
            break;
        }
    }

    let bPrev: CanonicalTreeNode | null = null;
    for (let j = bIndex - 1; j >= 0; j--) {
        if (!isEmptyNode(bSiblings[j])) {
            bPrev = bSiblings[j];
            break;
        }
    }

    // Look at next non-empty sibling
    let aNext: CanonicalTreeNode | null = null;
    for (let i = aIndex + 1; i < aSiblings.length; i++) {
        if (!isEmptyNode(aSiblings[i])) {
            aNext = aSiblings[i];
            break;
        }
    }

    let bNext: CanonicalTreeNode | null = null;
    for (let j = bIndex + 1; j < bSiblings.length; j++) {
        if (!isEmptyNode(bSiblings[j])) {
            bNext = bSiblings[j];
            break;
        }
    }

    // Compare previous context
    if (aPrev && bPrev) {
        contextCount++;
        // Same type is the PRIMARY signal for structural matching
        if (aPrev.type === bPrev.type) {
            score += 1.0;  // Full point for type match (structure is preserved)
            // Bonus if content also matches, but not required
            // if (aPrev.text === bPrev.text) {
            //     score += 0.0;  // No bonus - type match is sufficient
            // }
        }
    } else if (!aPrev && !bPrev) {
        // Both at start of section
        contextCount++;
        score += 1.0;
    }

    // Compare next context
    if (aNext && bNext) {
        contextCount++;
        // Same type is the PRIMARY signal for structural matching
        if (aNext.type === bNext.type) {
            score += 1.0;  // Full point for type match (structure is preserved)
            // Bonus if content also matches, but not required
            // if (aNext.text === bNext.text) {
            //     score += 0.0;  // No bonus - type match is sufficient
            // }
        }
    } else if (!aNext && !bNext) {
        // Both at end of section
        contextCount++;
        score += 1.0;
    }

    // Average the context matches
    return contextCount > 0 ? score / contextCount : 0;
}

// --- Pair cost with memo (includes local + aligned-children structural cost)
type PairKey = string;
const keyFor = (a: CanonicalTreeNode, b: CanonicalTreeNode): PairKey => `${a.id}|${b.id}`;

function pairCost(a: CanonicalTreeNode, b: CanonicalTreeNode, opts: DiffOpts, ctx: PairContext): number {
    const pairMemo = ctx.memo;
    const k = keyFor(a, b);
    if (pairMemo.has(k)) return pairMemo.get(k)!;

    if (!opts.allowTypePair!(a.type, b.type)) {
        // very high cost → will never be paired during alignment
        const cost = delCost(a, opts) + delCost(b, opts) + 1e6;
        pairMemo.set(k, cost); return cost;
    }

    if (sameSubtree(a, b, ctx)) {
        pairMemo.set(k, 0); return 0;
    }

    const local = localCost(a, b, opts, ctx);

    // Two leaves have no children to align, so `struct` is 0. Text runs inside
    // list items are most of the pairs in a list-heavy file; skip the DP setup.
    const A = kids(a), B = kids(b);
    if (A.length === 0 && B.length === 0) {
        pairMemo.set(k, local);
        return local;
    }

    // align children with *order-preserving* DP allowing matches only if pairCost ≤ threshold.
    // Identical leading/trailing children match at zero cost, so the DP only
    // covers the changed middle (offset `pre` into both sides).
    const { pre, suf } = identicalEdges(A, B, ctx);
    const m = A.length - pre - suf, n = B.length - pre - suf;
    ctx.budget.charge(m, n);
    const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = 1; i <= m; i++) dp[i][0] = dp[i - 1][0] + delCost(A[pre + i - 1], opts);
    for (let j = 1; j <= n; j++) dp[0][j] = dp[0][j - 1] + delCost(B[pre + j - 1], opts);

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const del = dp[i - 1][j] + delCost(A[pre + i - 1], opts);
            const ins = dp[i][j - 1] + delCost(B[pre + j - 1], opts);
            const best = Math.min(del, ins);
            const pc = childMatchCost(A, B, pre + i - 1, pre + j - 1, dp[i - 1][j - 1], best, opts, ctx);
            dp[i][j] = pc < Infinity ? Math.min(best, dp[i - 1][j - 1] + pc) : best;
        }
    }
    const struct = dp[m][n];
    const total = local + opts.wStruct * struct;

    pairMemo.set(k, total);
    return total;
}

/**
 * The part of `pairCost` that does not align children. The full cost only adds
 * `wStruct * struct` to it, and `struct` is never negative, so this is also a
 * lower bound on the full cost.
 */
function localCost(a: CanonicalTreeNode, b: CanonicalTreeNode, opts: DiffOpts, ctx: PairContext): number {
    const txt = (opts.isTextual!(a) && opts.isTextual!(b)) ? (1 - textSim(a, b, ctx)) : 0;
    const attr = attrDist(a.attrs, b.attrs);
    const typePen = a.type === b.type ? 0 : opts.typePenalty;
    return typePen + opts.wText * txt + opts.wAttr * attr;
}

/**
 * A lower bound on the `struct` term of `pairCost(a, b)`: the same alignment of
 * their children, but with each child pair costed by `localCost` and no
 * threshold refusal. Every cell input is at most its exact counterpart, so the
 * result is at most the exact `struct`. It costs one `localCost` per child
 * pair instead of a full recursion per child pair.
 */
function structLowerBound(a: CanonicalTreeNode, b: CanonicalTreeNode, opts: DiffOpts, ctx: PairContext): number {
    const A = kids(a), B = kids(b);
    const { pre, suf } = identicalEdges(A, B, ctx);
    const m = A.length - pre - suf, n = B.length - pre - suf;
    let prev = new Array<number>(n + 1);
    let cur = new Array<number>(n + 1);
    prev[0] = 0;
    for (let j = 1; j <= n; j++) prev[j] = prev[j - 1] + delCost(B[pre + j - 1], opts);
    for (let i = 1; i <= m; i++) {
        const ai = A[pre + i - 1];
        cur[0] = prev[0] + delCost(ai, opts);
        for (let j = 1; j <= n; j++) {
            const bj = B[pre + j - 1];
            const del = prev[j] + delCost(ai, opts);
            const ins = cur[j - 1] + delCost(bj, opts);
            // An empty-paragraph pair's context can bring its cost down to 0.
            const floor = (isEmptyNode(ai) && isEmptyNode(bj)) || sameSubtree(ai, bj, ctx)
                ? 0
                : localCost(ai, bj, opts, ctx);
            cur[j] = Math.min(del, ins, prev[j - 1] + floor);
        }
        [prev, cur] = [cur, prev];
    }
    return prev[n];
}

/**
 * Cost of matching child `A[i]` with `B[j]` inside a sibling alignment, or
 * Infinity when the match is refused (above `pairAlignThreshold`) or cannot
 * win the cell.
 *
 * A match is taken only if `dpDiag + cost` beats `best` (the cheaper of delete
 * and insert). When `dpDiag + localCost` already exceeds `best`, the full cost
 * -- which recursively aligns both subtrees -- cannot win or tie, so it is never
 * computed. Every DP value and backtrack choice is the same as computing it.
 * That skip is what keeps a list whose every item changed (a renumbered label,
 * #1606) from aligning every item's inline runs against every other item's.
 *
 * Empty paragraphs are never skipped: their contextual adjustment below can
 * lower the cost to 0, under the bound.
 */
function childMatchCost(
    A: CanonicalTreeNode[], B: CanonicalTreeNode[], i: number, j: number,
    dpDiag: number, best: number, opts: DiffOpts, ctx: PairContext,
): number {
    const a = A[i], b = B[j];
    const bothEmpty = isEmptyNode(a) && isEmptyNode(b);
    if (!bothEmpty && !ctx.memo.has(keyFor(a, b)) && opts.allowTypePair!(a.type, b.type)
        && !sameSubtree(a, b, ctx)) {
        const local = localCost(a, b, opts, ctx);
        if (dpDiag + local > best) return Infinity;
        // Two unrelated lists cost far more than their text difference once
        // their items are aligned; bound that alignment one level down before
        // paying for the full recursion.
        if (kids(a).length && kids(b).length
            && dpDiag + (local + opts.wStruct * structLowerBound(a, b, opts, ctx)) > best) {
            return Infinity;
        }
    }

    let c = pairCost(a, b, opts, ctx);

    // EMPTY NODE CONTEXTUAL MATCHING
    // For empty nodes (paragraphs with no text), they all have identical text (empty string)
    // so textSim("", "") = 1, making cost = 0. This makes TOPT unable to distinguish between
    // empty paragraphs in different contexts. We need to ADD COST based on context mismatch.
    if (bothEmpty) {
        const contextSim = contextualSimilarity(a, b, i, j, A, B);
        // contextSim ranges from 0 (no context match) to 1 (perfect context match)

        // For STRONG context matches (>= 0.8), treat as exact match with zero cost
        // This allows empty paragraphs in the same structural position to match cleanly
        if (contextSim >= 0.8) {
            c = 0;  // Perfect match - no cost

            if (isDiffDebug()) {
                console.log(`[TOPT] Empty node EXACT match [${i}]->[${j}]: contextSim=${contextSim.toFixed(3)}, cost=0.000 (strong context)`);
            }
        } else {
            // Add penalty for poor context: (1 - contextSim) * penalty
            // This makes empty nodes prefer matching in similar contexts
            // Make penalty VERY HIGH (higher than delete+insert cost) to force context-based matching
            const contextPenalty = (1 - contextSim) * 10.0;  // Penalty up to 10.0 for no context match
            c = c + contextPenalty;

            // Debug logging for empty node matching
            if (isDiffDebug()) {
                console.log(`[TOPT] Empty node pairing [${i}]->[${j}]: contextSim=${contextSim.toFixed(3)}, baseCost=${(c - contextPenalty).toFixed(3)}, penalty=${contextPenalty.toFixed(3)}, finalCost=${c.toFixed(3)}`);
            }
        }
    }

    // normalize to [0,1]ish by dividing by (del+ins) so threshold is meaningful across sizes
    const base = delCost(a, opts) + delCost(b, opts) || 1;
    const norm = c / base; // ~0 == identical, ~1 == replace
    if (norm <= opts.pairAlignThreshold) return c; // only allow "match" when similar enough

    // Debug: log blocked matches for empty nodes
    if (isDiffDebug() && bothEmpty) {
        console.log(`[TOPT] BLOCKED empty node pairing [${i}]->[${j}]: norm=${norm.toFixed(3)} > threshold=${opts.pairAlignThreshold}, cost=${c.toFixed(3)}, base=${base.toFixed(3)}`);
    }
    return Infinity;
}

// Recover the optimal child alignment (order-preserving; no "moves")
type Step = { kind: 'match'; i: number; j: number } | { kind: 'del'; i: number } | { kind: 'ins'; j: number };

function alignChildren(a: CanonicalTreeNode, b: CanonicalTreeNode, opts: DiffOpts, ctx: PairContext): Step[] {
    // No budget charge here: `walk` always resolves `pairCost(a, b)` before it
    // calls us, and that call already charged this pair's m*n cells. Charging
    // again would halve the effective budget for no extra safety.
    // Same trimming as `pairCost`: identical edges match in place and only the
    // changed middle (offset `pre`) goes through the DP.
    const A = kids(a), B = kids(b);
    const { pre, suf } = identicalEdges(A, B, ctx);
    const m = A.length - pre - suf, n = B.length - pre - suf;
    const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = 1; i <= m; i++) dp[i][0] = dp[i - 1][0] + delCost(A[pre + i - 1], opts);
    for (let j = 1; j <= n; j++) dp[0][j] = dp[0][j - 1] + delCost(B[pre + j - 1], opts);

    // Filled as the DP reaches each cell; the backtrack reads it.
    const PC: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(Infinity));
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
        const ai = A[pre + i - 1], bj = B[pre + j - 1];

        // CRITICAL: Force exact text matches to always be chosen
        // For textual nodes with identical text, force cost to 0 and take the
        // match regardless of other costs. This prevents position-based
        // alignments from winning over identity matches.
        // EXCEPT for empty paragraphs which need context to disambiguate
        const isEmpty = isEmptyNode(ai);
        if (opts.isTextual!(ai) && opts.isTextual!(bj) && ai.text === bj.text && !isEmpty) {
            PC[i - 1][j - 1] = 0;
            dp[i][j] = dp[i - 1][j - 1];
            continue;
        } else if (isDiffDebug() && isEmpty && ai.text === bj.text) {
            console.log(`[TOPT] NOT forcing exact match for empty node [${pre + i - 1}]->[${pre + j - 1}] (preserving contextual cost)`);
        }

        const del = dp[i - 1][j] + delCost(ai, opts);
        const ins = dp[i][j - 1] + delCost(bj, opts);
        const best = Math.min(del, ins);
        const pc = childMatchCost(A, B, pre + i - 1, pre + j - 1, dp[i - 1][j - 1], best, opts, ctx);
        PC[i - 1][j - 1] = pc;
        dp[i][j] = pc < Infinity ? Math.min(best, dp[i - 1][j - 1] + pc) : best;
    }

    // Backtrack in reverse: trailing identical run, the DP middle, then the
    // leading identical run. Step indices are always into the full child lists.
    const steps: Step[] = [];
    for (let s = 0; s < suf; s++) steps.push({ kind: 'match', i: A.length - 1 - s, j: B.length - 1 - s });
    let i = m, j = n;
    while (i > 0 || j > 0) {
        const canMatch = i > 0 && j > 0 && PC[i - 1][j - 1] < Infinity && dp[i][j] === dp[i - 1][j - 1] + PC[i - 1][j - 1];
        if (canMatch) { steps.push({ kind: 'match', i: pre + i - 1, j: pre + j - 1 }); i--; j--; continue; }
        if (i > 0 && dp[i][j] === dp[i - 1][j] + delCost(A[pre + i - 1], opts)) { steps.push({ kind: 'del', i: pre + i - 1 }); i--; continue; }
        steps.push({ kind: 'ins', j: pre + j - 1 }); j--;
    }
    for (let s = pre - 1; s >= 0; s--) steps.push({ kind: 'match', i: s, j: s });
    steps.reverse();
    return steps;
}

export function diffTrees(a: CanonicalTreeNode, b: CanonicalTreeNode, optsPartial: Partial<DiffOpts> = {}): DiffOp[] {
    const opts: DiffOpts = { ...DFLT, ...optsPartial };
    const ctx: PairContext = {
        memo: new Map<PairKey, number>(),
        budget: new PairBudget(opts.maxPairEvaluations),
        signatures: new WeakMap(),
        signatureIds: new Map(),
        tokens: new WeakMap(),
        patterns: new WeakMap(),
    };
    const ops: DiffOp[] = [];

    function walk(aNode: CanonicalTreeNode | null, bNode: CanonicalTreeNode | null, aPath: Path, bPath: Path) {
        if (aNode && !bNode) { ops.push({ op: 'delete', aPath, a: aNode }); return; }
        if (!aNode && bNode) { ops.push({ op: 'insert', bPath, b: bNode }); return; }

        const aN = aNode!, bN = bNode!;
        const cost = pairCost(aN, bN, opts, ctx);

        // Decide "equal" vs "replace" for this node pair
        if (cost <= opts.equalThreshold) {
            ops.push({ op: 'equal', aPath, bPath, a: aN, b: bN });
        } else if (!opts.allowTypePair!(aN.type, bN.type)) {
            ops.push({ op: 'replace', aPath, bPath, a: aN, b: bN });
            return; // incompatible types; do not descend
        } else {
            ops.push({ op: 'replace', aPath, bPath, a: aN, b: bN });
        }

        // Align children in order; reorders will surface as delete+insert
        const steps = alignChildren(aN, bN, opts, ctx);
        for (const s of steps) {
            if (s.kind === 'match') {
                walk(kids(aN)[s.i], kids(bN)[s.j], [...aPath, s.i], [...bPath, s.j]);
            } else if (s.kind === 'del') {
                const child = kids(aN)[s.i];
                walk(child, null, [...aPath, s.i], bPath);
            } else {
                const child = kids(bN)[s.j];
                walk(null, child, aPath, [...bPath, s.j]);
            }
        }
    }

    walk(a, b, [], []);
    return ops;
}
