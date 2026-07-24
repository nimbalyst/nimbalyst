import type {CanonicalTreeNode} from './canonicalTree';

type Path = number[];

export type DiffOp =
    | { op: 'equal'; aPath: Path; bPath: Path; a: CanonicalTreeNode; b: CanonicalTreeNode }
    | { op: 'insert'; bPath: Path; b: CanonicalTreeNode }
    | { op: 'delete'; aPath: Path; a: CanonicalTreeNode }
    | { op: 'replace'; aPath: Path; bPath: Path; a: CanonicalTreeNode; b: CanonicalTreeNode };

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
function lcsLen<T>(A: T[], B: T[]): number {
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
        dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
    return dp[n][m];
}
function textSim(a?: string, b?: string): number {
    const A = tok(a), B = tok(b);
    if (!A.length && !B.length) return 1;
    if (!A.length || !B.length) return 0;
    return lcsLen(A, B) / Math.max(A.length, B.length);
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

function pairCost(a: CanonicalTreeNode, b: CanonicalTreeNode, opts: DiffOpts, pairMemo: Map<PairKey, number>): number {
    const k = keyFor(a, b);
    if (pairMemo.has(k)) return pairMemo.get(k)!;

    if (!opts.allowTypePair!(a.type, b.type)) {
        // very high cost → will never be paired during alignment
        const cost = delCost(a, opts) + delCost(b, opts) + 1e6;
        pairMemo.set(k, cost); return cost;
    }

    const textSimValue = textSim(a.text, b.text);
    const txt = (opts.isTextual!(a) && opts.isTextual!(b)) ? (1 - textSimValue) : 0;
    const attr = attrDist(a.attrs, b.attrs);
    const typePen = a.type === b.type ? 0 : opts.typePenalty;

    // align children with *order-preserving* DP allowing matches only if pairCost ≤ threshold
    const A = kids(a), B = kids(b);
    const m = A.length, n = B.length;
    const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = 1; i <= m; i++) dp[i][0] = dp[i - 1][0] + delCost(A[i - 1], opts);
    for (let j = 1; j <= n; j++) dp[0][j] = dp[0][j - 1] + delCost(B[j - 1], opts);

    // Precompute child pair costs (and refuse matches above threshold)
    const PC: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(Infinity));
    for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
        let c = pairCost(A[i], B[j], opts, pairMemo);

        // EMPTY NODE CONTEXTUAL MATCHING (same as in alignChildren)
        if (isEmptyNode(A[i]) && isEmptyNode(B[j])) {
            const contextSim = contextualSimilarity(A[i], B[j], i, j, A, B);
            // For strong context matches, treat as exact match
            if (contextSim >= 0.8) {
                c = 0;
            } else {
                const contextPenalty = (1 - contextSim) * 10.0;
                c = c + contextPenalty;
            }
        }

        // normalize to [0,1]ish by dividing by (del+ins) so threshold is meaningful across sizes
        const base = delCost(A[i], opts) + delCost(B[j], opts) || 1;
        const norm = c / base; // ~0 == identical, ~1 == replace
        PC[i][j] = norm <= opts.pairAlignThreshold ? c : Infinity;
    }

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const del = dp[i - 1][j] + delCost(A[i - 1], opts);
            const ins = dp[i][j - 1] + delCost(B[j - 1], opts);
            const match = PC[i - 1][j - 1] < Infinity ? dp[i - 1][j - 1] + PC[i - 1][j - 1] : Infinity;
            dp[i][j] = Math.min(del, ins, match);
        }
    }
    const struct = dp[m][n];
    const total = typePen + opts.wText * txt + opts.wAttr * attr + opts.wStruct * struct;

    pairMemo.set(k, total);
    return total;
}

// Recover the optimal child alignment (order-preserving; no "moves")
type Step = { kind: 'match'; i: number; j: number } | { kind: 'del'; i: number } | { kind: 'ins'; j: number };

function alignChildren(a: CanonicalTreeNode, b: CanonicalTreeNode, opts: DiffOpts, pairMemo: Map<PairKey, number>): Step[] {
    const A = kids(a), B = kids(b);
    const m = A.length, n = B.length;
    const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = 1; i <= m; i++) dp[i][0] = dp[i - 1][0] + delCost(A[i - 1], opts);
    for (let j = 1; j <= n; j++) dp[0][j] = dp[0][j - 1] + delCost(B[j - 1], opts);

    const PC: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(Infinity));
    const isExactMatch: boolean[][] = Array.from({ length: m }, () => new Array<boolean>(n).fill(false));
    for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
        let c = pairCost(A[i], B[j], opts, pairMemo);
        const base = delCost(A[i], opts) + delCost(B[j], opts) || 1;

        // EMPTY NODE CONTEXTUAL MATCHING
        // For empty nodes (paragraphs with no text), they all have identical text (empty string)
        // so textSim("", "") = 1, making cost = 0. This makes TOPT unable to distinguish between
        // empty paragraphs in different contexts. We need to ADD COST based on context mismatch.
        if (isEmptyNode(A[i]) && isEmptyNode(B[j])) {
            const contextSim = contextualSimilarity(A[i], B[j], i, j, A, B);
            // contextSim ranges from 0 (no context match) to 1 (perfect context match)

            // For STRONG context matches (>= 0.8), treat as exact match with zero cost
            // This allows empty paragraphs in the same structural position to match cleanly
            if (contextSim >= 0.8) {
                c = 0;  // Perfect match - no cost

                if (process?.env?.DIFF_DEBUG === '1') {
                    console.log(`[TOPT] Empty node EXACT match [${i}]->[${j}]: contextSim=${contextSim.toFixed(3)}, cost=0.000 (strong context)`);
                }
            } else {
                // Add penalty for poor context: (1 - contextSim) * penalty
                // This makes empty nodes prefer matching in similar contexts
                // Make penalty VERY HIGH (higher than delete+insert cost) to force context-based matching
                const contextPenalty = (1 - contextSim) * 10.0;  // Penalty up to 10.0 for no context match
                c = c + contextPenalty;

                // Debug logging for empty node matching
                if (process?.env?.DIFF_DEBUG === '1') {
                    console.log(`[TOPT] Empty node pairing [${i}]->[${j}]: contextSim=${contextSim.toFixed(3)}, baseCost=${(c - contextPenalty).toFixed(3)}, penalty=${contextPenalty.toFixed(3)}, finalCost=${c.toFixed(3)}`);
                }
            }
        }

        const norm = c / base;
        if (norm <= opts.pairAlignThreshold) {
            PC[i][j] = c; // only allow "match" when similar enough
        } else {
            // Debug: log blocked matches for empty nodes
            if (process?.env?.DIFF_DEBUG === '1' && isEmptyNode(A[i]) && isEmptyNode(B[j])) {
                console.log(`[TOPT] BLOCKED empty node pairing [${i}]->[${j}]: norm=${norm.toFixed(3)} > threshold=${opts.pairAlignThreshold}, cost=${c.toFixed(3)}, base=${base.toFixed(3)}`);
            }
        }

        // Track exact text matches - these should always be chosen
        // For textual nodes with identical text, force cost to 0 to ensure they match
        // EXCEPT for empty paragraphs which need context to disambiguate
        const isEmpty = isEmptyNode(A[i]);
        if (opts.isTextual!(A[i]) && opts.isTextual!(B[j]) && A[i].text === B[j].text && !isEmpty) {
            isExactMatch[i][j] = true;
            PC[i][j] = 0;  // Zero cost ensures exact matches are always chosen
        } else if (process?.env?.DIFF_DEBUG === '1' && isEmpty && A[i].text === B[j].text) {
            console.log(`[TOPT] NOT forcing exact match for empty node [${i}]->[${j}] (preserving contextual cost)`);
        }
    }

    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
        const del = dp[i - 1][j] + delCost(A[i - 1], opts);
        const ins = dp[i][j - 1] + delCost(B[j - 1], opts);
        const match = PC[i - 1][j - 1] < Infinity ? dp[i - 1][j - 1] + PC[i - 1][j - 1] : Infinity;

        // CRITICAL: Force exact text matches to always be chosen
        // When we have an exact text match, use it regardless of other costs
        // This prevents position-based alignments from winning over identity matches
        if (i > 0 && j > 0 && isExactMatch[i - 1][j - 1] && match < Infinity) {
            dp[i][j] = dp[i - 1][j - 1];  // Match is free (cost already set to 0 in PC)
        } else {
            dp[i][j] = Math.min(del, ins, match);
        }
    }

    const steps: Step[] = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        const canMatch = i > 0 && j > 0 && PC[i - 1][j - 1] < Infinity && dp[i][j] === dp[i - 1][j - 1] + PC[i - 1][j - 1];
        if (canMatch) { steps.push({ kind: 'match', i: i - 1, j: j - 1 }); i--; j--; continue; }
        if (i > 0 && dp[i][j] === dp[i - 1][j] + delCost(A[i - 1], opts)) { steps.push({ kind: 'del', i: i - 1 }); i--; continue; }
        steps.push({ kind: 'ins', j: j - 1 }); j--;
    }
    steps.reverse();
    return steps;
}

export function diffTrees(a: CanonicalTreeNode, b: CanonicalTreeNode, optsPartial: Partial<DiffOpts> = {}): DiffOp[] {
    const opts: DiffOpts = { ...DFLT, ...optsPartial };
    const memo = new Map<PairKey, number>();
    const ops: DiffOp[] = [];

    function walk(aNode: CanonicalTreeNode | null, bNode: CanonicalTreeNode | null, aPath: Path, bPath: Path) {
        if (aNode && !bNode) { ops.push({ op: 'delete', aPath, a: aNode }); return; }
        if (!aNode && bNode) { ops.push({ op: 'insert', bPath, b: bNode }); return; }

        const aN = aNode!, bN = bNode!;
        const cost = pairCost(aN, bN, opts, memo);

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
        const steps = alignChildren(aN, bN, opts, memo);
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
