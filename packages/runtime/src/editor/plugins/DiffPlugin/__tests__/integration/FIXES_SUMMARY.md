# Diff Plugin Fixes Summary

## Problems Fixed

### 1. Title Disappearing Bug (canonicalTree.ts)

**Problem**: When applying diffs, node content (like heading text) was disappearing.

**Root Cause**: In `buildCanonicalTree`, the `serialized` field was created by calling `node.exportJSON()`, which returns a serialized node with empty children. The function then built the `children` array correctly for the CanonicalTreeNode, but never updated `serialized.children` to match. Later, when NodeDiff operations referenced `diff.sourceNode` and `diff.targetNode` (which come from the serialized fields), they had empty children arrays, causing content loss.

**Fix** (line 125-131 in canonicalTree.ts):
```typescript
// CRITICAL FIX: Update serialized.children to match the canonical children
// Without this, serialized nodes have empty children arrays even when the
// CanonicalTreeNode has populated children. This causes content to disappear
// when diff operations are applied because they use the serialized nodes.
if ('children' in serialized && children.length > 0) {
  serialized.children = children.map(c => c.serialized);
}
```

### 2. Exact Matches Marked as Changed (TreeMatcher.ts)

**Problem**: Nodes that were identical in both documents were being marked as "modified" with green/red highlighting.

**Root Cause**: TreeMatcher was creating NodeDiff operations for ALL matched nodes, even exact matches. When `$applyNodeDiff` processed these operations, it marked them with diff states.

**Fix** (line 251-261 in TreeMatcher.ts):
```typescript
// CRITICAL: Skip exact matches - they require no diff operations
// Exact matches mean the nodes are identical, so there's nothing to apply
// Only create NodeDiff entries for actual changes (replace ops or similarity < 1.0)
if (isExact && similarity === 1.0) {
  // Still mark as matched to prevent false delete/add pairs,
  // but don't create a diff operation
  continue;
}
```

### 3. LiveNodeKey Polluting Similarity Comparison (canonicalTree.ts)

**Problem**: The `calculateSimilarity` function was returning 0.9 instead of 1.0 for identical nodes, causing exact matches to not be detected.

**Root Cause**: The `extractAttrs` function was including the `$` field in the attributes comparison. This field contains internal metadata like `liveNodeKey`, which differs between the source and target editors even when the content is identical.

**Fix** (line 52-69 in canonicalTree.ts):
```typescript
function extractAttrs(serialized: SerializedLexicalNode): Record<string, any> | undefined {
  const {children, text, detail, format, mode, $, ...rest} =
    serialized as Record<string, unknown>;
  // ... rest of function

  // CRITICAL: Exclude $ field which contains internal metadata like liveNodeKey
  // The $ field is for internal tracking and should not affect similarity comparison
}
```

## Test Results

### Before Fixes
- Title content disappeared after applying diffs
- All nodes marked as "modified" even when unchanged
- `similarity = 0.9` for identical nodes
- `unchangedNodes = 0` in all tests

### After Fixes
- Title content preserved: `contains title: true` ✓
- Exact matches skipped: `[TreeMatcher] Skipping exact match at source[0] -> target[0]: heading "Title"` ✓
- Similarity correctly 1.0 for identical content ✓
- Only actual changes marked as modified ✓

## Files Modified

1. `./packages/rexical/src/plugins/DiffPlugin/core/canonicalTree.ts`
   - Added `serialized.children` population in `buildCanonicalTree`
   - Excluded `$` field from `extractAttrs`

2. `./packages/rexical/src/plugins/DiffPlugin/core/TreeMatcher.ts`
   - Added check to skip exact matches (isExact && similarity === 1.0)
   - Added debug logging for similarity calculations

## Testing

Run the tests:
```bash
# Main test that was failing
npx vitest run src/plugins/DiffPlugin/__tests__/unit/larger-doc-test2.test.ts

# Comprehensive integration tests
npx vitest run src/plugins/DiffPlugin/__tests__/integration/comprehensive-diff.test.ts

# Exact match detection tests
npx vitest run src/plugins/DiffPlugin/__tests__/integration/exact-match.test.ts
```

## Next Steps

The core issues are fixed, but there are still some edge cases in the accept/reject cycle that need investigation. The test framework in `./packages/rexical/src/plugins/DiffPlugin/__tests__/integration/` provides comprehensive testing infrastructure for continued work.
