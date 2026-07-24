# How to Apply the Fixes to Your App

## The fixes are in place, but you need to rebuild

The test suite shows that the fixes ARE working:
- Exact matches are being skipped ✓
- Unchanged nodes have `diffState: null` ✓
- Only actual changes are marked ✓

But if you're still seeing unchanged content marked in the app, it's because the app needs to be rebuilt with the new code.

## Steps to Apply Fixes

### 1. Rebuild the rexical package
```bash
cd packages/rexical
npm run build
```

### 2. Rebuild the electron app
```bash
cd ../electron
npm run build
```

### 3. Restart the development server (if running)
```bash
# Kill any running dev servers
pkill -f "npm run dev"

# Start fresh
cd packages/electron
npm run dev
```

## Verify the Fixes

### Test 1: Run the unit tests
```bash
cd packages/rexical
npx vitest run src/plugins/DiffPlugin/__tests__/unit/larger-doc-test2.test.ts
```

You should see:
```
After applying diff: 2831 bytes, contains title: true ✓
After accepting all: 2831 bytes, contains title: true ✓
```

### Test 2: Run the integration tests
```bash
npx vitest run src/plugins/DiffPlugin/__tests__/integration/debug-unchanged-marked.test.ts
```

You should see:
```
Unchanged: 3
Modified: 0
Added: 2
```

### Test 3: In the app

1. Open a document
2. Make a small change (add one paragraph)
3. Apply the diff

**Expected behavior:**
- Only the NEW content should be highlighted in green
- Only REMOVED content should be highlighted in red
- Unchanged content should have NO highlighting

**If unchanged content still shows highlighting:**
1. Check browser console for any errors
2. Try hard refresh (Cmd+Shift+R)
3. Clear app cache
4. Verify the build completed without errors

## What Was Fixed

### Fix 1: canonicalTree.ts (lines 129-131)
Serialized nodes now include their children, preventing content loss.

### Fix 2: canonicalTree.ts (line 53)
The `$` field (containing liveNodeKey) is excluded from attribute comparison.

### Fix 3: TreeMatcher.ts (lines 254-261)
Exact matches (similarity === 1.0 && isExact) are skipped entirely.

## Debug Mode

To see detailed diff logging:
```bash
DIFF_DEBUG=1 npm run dev
```

This will show in the console:
- `[TreeMatcher] Skipping exact match...` for unchanged nodes
- `[TreeMatcher] Creating UPDATE for...` only for changed nodes
- Similarity scores for each comparison

## Still Having Issues?

If unchanged content is still being marked after rebuilding:

1. **Check for subtle differences:**
   - Extra spaces or newlines
   - Different formatting (e.g., `**bold**` vs `__bold__`)
   - Zero-width characters or special Unicode

2. **Export both versions and compare:**
   ```bash
   # In your test
   console.log('Old:', JSON.stringify(oldMarkdown));
   console.log('New:', JSON.stringify(newMarkdown));
   ```

3. **Check the similarity threshold:**
   The code uses `similarity === 1.0` for exact matches. If similarity is 0.99, it will still be marked as changed. Check the console with `DIFF_DEBUG=1` to see actual similarity values.
