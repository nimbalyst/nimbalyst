---
planStatus:
  planId: plan-zhang-shasha-correct
  title: Order-Preserving Tree Diff Implementation
  status: ready-for-development
  planType: refactor
  priority: critical
  owner: developer
  stakeholders:
    - developer
  tags:
    - diff-plugin
    - tree-matching
    - algorithms
    - testing
    - order-preserving
  created: "2025-11-05"
  updated: "2025-11-06T14:00:00.000Z"
  progress: 60
---
# Order-Preserving Tree Diff Implementation

## Goals

1. ~~Implement Zhang-Shasha tree edit distance algorithm correctly for document diffing~~ **ABANDONED - See Critical Discovery**
2. Use ThresholdedOrderPreservingTree algorithm for order-preserving document diffs
3. Integrate algorithm into TreeMatcher with proper node conversion
4. Create systematic test suite covering all markdown node types
5. Verify accept/reject operations work correctly

## Problem with Current Implementation

**Critical Failure**: Current Levenshtein-based approach is fundamentally broken:
- When first heading changes (e.g., "Title" → "Title's"), shows removed at position 0, added at position 31
- Levenshtein is positional and gets confused when first node has high update cost
- Manual "container node detection" and recursion is a hack that doesn't solve the root problem

**What Went Wrong with Original Zhang-Shasha Attempt**:
1. **Flattened the tree**: Extracted only `root.getChildren()` as flat array, lost all nested structure
2. **Fake root wrapper**: Created artificial root with children that had NO children (all empty arrays)
3. **Wrong cost function**: Set update cost = 1000.0 for any content difference, causing algorithm to choose remove+add for everything
4. **No tree recursion**: Zhang-Shasha had nothing to recurse into because structure was flat

## CRITICAL DISCOVERY: Zhang-Shasha Library Doesn't Preserve Order (2025-11-06)

**The ****`edit-distance`**** npm library's Zhang-Shasha implementation DOES NOT preserve order!**

### The Problem

When testing pure additions (adding new sections at the end of a document), the library matches nodes in the WRONG order:

**Document:**
- Old: [0]=Title, [1]=empty, [2]="First section", [3]=empty
- New: [0]=Title, [1]=empty, [2]="First section", [3]=empty, [4]="New Section", [5]=empty, [6]="New content", [7]=empty

**Expected matching (order-preserving):**
- Old[0] Title → New[0] Title (EQUAL)
- Old[2] "First section" → New[2] "First section" (EQUAL)
- New[4-7] all INSERT

**Actual matching from library:**
- Old[0] Title → New[4] "New Section" (UPDATE!)
- Old[2] "First section" → New[6] "New content" (UPDATE!)
- New[0] Title (INSERT!)
- New[2] "First section" (INSERT!)

The library computed the CORRECT minimum distance (22) but returned the WRONG pairs. It's matching nodes across large position gaps, which breaks document diff visualization.

### Root Cause

Zhang-Shasha algorithm itself DOES care about order (uses post-order indexing), but there may be multiple optimal solutions with the same cost. The library appears to choose an arbitrary solution rather than preferring positionally-close matches.

For document diffs, we MUST preserve order - old[0] can only match new[0] (with gaps for inserts/deletes). Cross-matching destroys the visual diff structure.

### The Solution: ThresholdedOrderPreservingTree

**File**: `packages/rexical/src/plugins/DiffPlugin/core/ThresholdedOrderPreservingTree.ts`

This is a custom order-preserving tree diff algorithm that explicitly enforces sequential alignment:
- Uses dynamic programming with order-preserving alignment
- Only allows matches where position order is maintained
- Handles moves as DELETE + INSERT (correct for order-preserving diffs)
- Supports threshold-based pairing (only match similar enough nodes)

**Test Results**: ALL tests pass with correct order preservation.

## Solution Approach - VALIDATED WITH ThresholdedOrderPreservingTree

### Prototype Results (2025-11-06)

**Created working prototype**: `packages/rexical/src/plugins/DiffPlugin/__tests__/unit/raw-tree-prototype.test.ts`

**ORDER-PRESERVING tests ALL PASS:**
- ✓ Heading text change: Shows REPLACE [0]->[0] with child text change "Title" → "Title's"
- ✓ Pure addition: New sections correctly shown as INSERT (not matched with old content!)
- ✓ Complex document: Lists with nested changes, moved paragraphs handled correctly

**Example Tree View Output:**
```
🔄 REPLACE []->[]: root "" → root ""
  🔄 REPLACE [0]->[0]: heading "Title" → heading "Title's"
    🔄 REPLACE [0,0]->[0,0]: text "Title" → text "Title's"
  ✓ EQUAL [1]->[1]: paragraph ""
  ✓ EQUAL [2]->[2]: paragraph "Content here."
    ✓ EQUAL [2,0]->[2,0]: text "Content here."
```

**Complex document with list changes:**
```
✓ EQUAL [8]->[10]: list "Feature oneFeature twoFeature ..."
  ✓ EQUAL [8,0]->[10,0]: listitem "Feature one"
    ✓ EQUAL [8,0,0]->[10,0,0]: text "Feature one"
  ✓ EQUAL [8,1]->[10,1]: listitem "Feature two"
    🔄 REPLACE [8,1,0]->[10,1,0]: text "Feature two" → text "Feature two updated"
  ✓ EQUAL [8,2]->[10,2]: listitem "Feature three"
```

### Key Insights from Prototype

**1. Use Raw Lexical Serialized Trees**
- NO markdown conversion needed
- Pass `editor.getEditorState().toJSON()` to algorithm
- Convert to ThresholdNode format: `{ id, type, text, children }`
- Text content extracted recursively for similarity comparison

**2. Order-Preserving Alignment**
- Uses DP with order constraints
- old[i] can only match new[j] where j maintains sequential order
- No cross-matching (old[0] can't match new[10])
- Moves appear as DELETE + INSERT (correct for document diffs)

**3. Threshold-Based Pairing**
- `pairAlignThreshold: 0.8` - only match nodes with >80% similarity
- `equalThreshold: 0.1` - nodes with <10% difference marked EQUAL vs REPLACE
- Prevents matching dissimilar nodes just to minimize edit distance

**4. Hierarchical Structure Preserved**
- Operations include paths: `[8,1,0]` = root → list[8] → listitem[1] → text[0]
- Tree view shows nested changes clearly
- Child operations visible under parent operations

**5. Operation Types**
- `EQUAL`: Identical nodes (✓)
- `REPLACE`: Same position, different content (🔄)
- `INSERT`: New content (➕)
- `DELETE`: Removed content (➖)

### ThresholdedOrderPreservingTree Algorithm Details

**Node Conversion**:
- Build from `editor.getEditorState().toJSON()`
- Convert to ThresholdNode format: `{ id, type, text, children }`
- Assign sequential IDs during conversion
- Extract text content recursively for all nodes

**Algorithm Features**:
- Order-preserving DP alignment of children at each level
- Threshold-based pairing prevents dissimilar matches
- Text similarity via LCS (Longest Common Subsequence) on word tokens
- Attribute comparison for node metadata
- Hierarchical cost calculation includes aligned children

### Systematic Testing Approach

**Current tests are garbage**: Random scenarios, no structure, inconsistent assertions

**New test structure** (in new folder: `__tests__/systematic/`):

For each markdown node type:
1. **Old markdown**: Source content
2. **New markdown**: Target content with change
3. **Diff calculation**: Apply diff algorithm
4. **Visualization assertions**: Check which nodes marked added/removed/modified
5. **Accept test**: Apply accept → convert to markdown → should equal New markdown
6. **Reject test**: Apply reject → convert to markdown → should equal Old markdown

**Test matrix to cover**:
- Headings (h1-h6)
- Paragraphs
- Lists (bullet, numbered)
- List items (simple, nested)
- Formatting (bold, italic, strikethrough)
- Links
- Code blocks
- Tables
- Custom nodes (if any)

For each node type, test:
- Add operation
- Remove operation
- Modify operation
- Accept → New verification
- Reject → Old verification

## Implementation Plan

### Phase 0: Prototype ✅ COMPLETE

**Files created**:
- `packages/rexical/src/plugins/DiffPlugin/__tests__/unit/raw-tree-prototype.test.ts` - Working prototype with 3 passing tests

**Key learnings**:
1. Use `editor.getEditorState().toJSON()` for tree structure
2. Size-weighted costs (empty nodes = 0.01, content scales by length)
3. Hierarchical operation extraction with recursive childOps
4. Accept limitation: identical empty nodes may match ambiguously

### Phase 1: Integrate ThresholdedOrderPreservingTree into TreeMatcher (NEXT)

**Files to modify**:
- `packages/rexical/src/plugins/DiffPlugin/core/TreeMatcher.ts`

**Key changes**:
1. Import `diffTrees` from `ThresholdedOrderPreservingTree.ts`
2. Add `convertToThresholdNode()` function to convert CanonicalTreeNode → ThresholdNode
3. Replace `computeZhangShashaDistance()` with `diffTrees()` call
4. Convert DiffOp results from ThresholdedOrderPreservingTree to NodeDiff format
5. Update `matchRootChildren()` to use new algorithm
6. Configure thresholds: `pairAlignThreshold: 0.8`, `equalThreshold: 0.1`

**Node conversion**:
```typescript
function convertToThresholdNode(canonical: CanonicalTreeNode, idCounter: {value: number}): ThresholdNode {
  const id = idCounter.value++;
  const type = canonical.type;
  const text = canonical.payload; // Already contains text content
  const children = canonical.children.map(c => convertToThresholdNode(c, idCounter));
  return { id, type, text, children };
}
```

**Operation conversion**:
- `EQUAL` → NodeDiff with `changeType: 'update'`, `matchType: 'exact'`
- `REPLACE` → NodeDiff with `changeType: 'update'`, `matchType: 'similar'`
- `INSERT` → NodeDiff with `changeType: 'add'`
- `DELETE` → NodeDiff with `changeType: 'remove'`

### Phase 2: Create Systematic Test Suite

**New test directory**:
- `packages/rexical/src/plugins/DiffPlugin/__tests__/systematic/`

**Test file organization**:
- `headings.test.ts` - All heading level tests
- `paragraphs.test.ts` - Paragraph modification tests
- `lists.test.ts` - List and list item tests
- `formatting.test.ts` - Bold, italic, links, etc.
- `tables.test.ts` - Table modification tests
- `code-blocks.test.ts` - Code block tests

**Each test should**:
- Define old markdown
- Define new markdown
- Apply diff
- Assert visualization correctness
- Assert accept produces new markdown
- Assert reject produces old markdown

### Phase 3: Verify All Operations

**Acceptance criteria**:
1. All systematic tests pass
2. Heading change shows old/new adjacent (not separated)
3. Accept operation produces exact target markdown
4. Reject operation produces exact source markdown
5. No spurious add/remove operations
6. Performance acceptable on documents with 500+ nodes

## Files Affected

**Modified**:
- `packages/rexical/src/plugins/DiffPlugin/core/TreeMatcher.ts` - Fix tree structure
- `packages/rexical/src/plugins/DiffPlugin/core/diffUtils.ts` - Remove manual recursion

**New directory**:
- `packages/rexical/src/plugins/DiffPlugin/__tests__/systematic/` - All new tests

**Deprecated** (keep but don't rely on):
- `__tests__/unit/larger-doc-bug.test.ts` - Original test
- `__tests__/unit/list-item-changes.test.ts` - Levenshtein-specific test
- `__tests__/unit/simple-heading-change.test.ts` - Garbage test
- `__tests__/unit/heading-change-large-doc.test.ts` - Garbage test

## Key Technical Decisions

**Why ThresholdedOrderPreservingTree over Zhang-Shasha**:
- **Order preservation is critical**: Document diffs MUST show changes in position order
- Zhang-Shasha library allows cross-matching (old[0] → new[10]), breaking visual diffs
- ThresholdedOrderPreservingTree explicitly enforces sequential alignment
- Moves correctly shown as DELETE + INSERT (not spurious UPDATEs)

**Why not pure Zhang-Shasha**:
- `edit-distance` npm library doesn't preserve order in pairs
- Library returns correct distance but wrong node mappings
- Multiple optimal solutions exist; library chooses arbitrary one
- We need position-aware matching for document diffs

**Why systematic tests**:
- Current tests are random scenarios that don't catch systematic failures
- Need to verify EVERY node type works correctly
- Need to verify accept/reject actually produces correct markdown
- Matrix approach ensures complete coverage

**Threshold-based pairing**:
- Prevents matching dissimilar nodes just to minimize distance
- `pairAlignThreshold: 0.8` - only match nodes with high similarity
- Better than pure minimum edit distance for document diffs

## Success Metrics

1. **Correctness**: All systematic tests pass
2. **Visualization**: Adjacent old/new for simple changes
3. **Accept**: Produces exact target markdown
4. **Reject**: Produces exact source markdown
5. **Performance**: < 500ms for 500-node documents
6. **Coverage**: All markdown node types tested

## Non-Goals

- Character-level inline diffs (can add later if needed)
- Optimization for massive documents (>1000 nodes)
- Similarity-based fuzzy matching (exact or different only)

## Risks and Mitigation

**Risk**: Zhang-Shasha might be slow on large documents
**Mitigation**: Profile with 500+ node documents, optimize if needed

**Risk**: Tree structure conversion might be complex
**Mitigation**: Start with simple cases, add complexity incrementally

**Risk**: Tests might not catch all edge cases
**Mitigation**: Systematic matrix ensures comprehensive coverage
