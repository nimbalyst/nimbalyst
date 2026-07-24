---
planStatus:
  planId: plan-zhang-shasha-correct
  title: Correct Zhang-Shasha Implementation for Tree Diff
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
  created: "2025-11-05"
  updated: "2025-11-06T08:00:00.000Z"
  progress: 40
---
# Correct Zhang-Shasha Implementation for Tree Diff

## Goals

1. Implement Zhang-Shasha tree edit distance algorithm correctly for document diffing
2. Pass actual tree structure to the algorithm (not flattened arrays)
3. Create systematic test suite covering all markdown node types
4. Verify accept/reject operations work correctly

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

## Solution Approach - VALIDATED IN PROTOTYPE

### Prototype Results (2025-11-06)

**Created working prototype**: `packages/rexical/src/plugins/DiffPlugin/__tests__/unit/raw-tree-prototype.test.ts`

All tests pass:
- ✓ Heading text change: Shows UPDATE [0] -> [0] with child text change
- ✓ Section move: Content-based matching works correctly
- ✓ Complex document: Lists, paragraphs, and content nodes handled correctly

### Key Insights from Prototype

**1. Use Raw Lexical Serialized Trees**
- NO markdown conversion needed
- Pass `editor.getEditorState().toJSON()` directly to Zhang-Shasha
- Algorithm compares Lexical node structure naturally

**2. Size-Weighted Costs**
```typescript
insert = (node) => nodeSize(node)  // Larger nodes = higher cost
remove = (node) => nodeSize(node)  // Larger nodes = higher cost
update = (a, b) => {
  if (a.type !== b.type) return 1000.0;  // Different types impossible
  if (nodesIdentical(a, b)) return 0.0;   // Identical = free
  return 0.1;                              // Same type different content = cheap
}
```

**Size calculation**:
- Empty paragraphs: 0.01 (basically free)
- Text nodes: `text.length * 0.1`
- Containers: sum of children sizes
- Lists: minimum 1.0

This makes algorithm prefer matching large content nodes and ignore small empty nodes.

**3. Hierarchical Operation Extraction**
- Zhang-Shasha returns pairs at ALL tree levels
- Extract operations hierarchically:
    - Root level: add/remove/update
    - For each UPDATE: recurse into children
    - Build nested childOps structure
- Example output:
```
  UPDATE [0] -> [0]: heading
    REMOVE [0]: text "Title"
    ADD [0]: text "Title's"
```

**4. Accepted Limitation**
- Many identical empty paragraphs can match ambiguously
- This is fundamental to tree edit distance with indistinguishable nodes
- Solution: Focus on content nodes (headings, paragraphs with text, lists)
- Empty spacing nodes are handled but may not match perfectly

### Use Zhang-Shasha Correctly

**Pass actual tree structure**:
- Build from `editor.getEditorState().toJSON()`
- Recursively convert: `{ serialized: node, children: [...] }`
- Document root → [heading, paragraph, list, heading, ...]
- List → [listitem, listitem, listitem]
- Listitem → [text] or [text, nested-list]
- Paragraph → [text, formatted-text, link, text]

**No manual recursion needed**: Zhang-Shasha handles tree recursion natively

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

### Phase 1: Integrate into TreeMatcher (NEXT)

**Files to modify**:
- `packages/rexical/src/plugins/DiffPlugin/core/TreeMatcher.ts`

**Key changes**:
1. Add `buildTreeFromSerialized()` function from prototype
2. Add `nodeSize()` function for size-weighted costs
3. Add `nodesIdentical()` function for comparison
4. Replace `computeZhangShashaMapping()` with prototype approach
5. Add `extractOpsHierarchical()` for hierarchical operation extraction
6. Update `matchRootChildren()` to use new approach

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

**Why Zhang-Shasha over Levenshtein**:
- Documents are trees (root → sections → paragraphs/lists → items → text/formatting)
- Zhang-Shasha is designed for tree structures with sequences at each level
- Levenshtein is positional (sequence-only) and breaks when position 0 changes

**Why systematic tests**:
- Current tests are random scenarios that don't catch systematic failures
- Need to verify EVERY node type works correctly
- Need to verify accept/reject actually produces correct markdown
- Matrix approach ensures complete coverage

**No character-level Levenshtein for now**:
- Even "text chunks" are trees (formatting, links, etc.)
- Zhang-Shasha should handle this naturally
- Can optimize later if needed

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
