# app.asar Bundle Analysis

**Date:** 2025-11-05
**app.asar size:** 412MB
**Total files in asar:** 26,832 files
**Source maps in asar:** 4,377 files (16% of all files)

## Executive Summary

The 412MB app.asar file contains massive amounts of unnecessary code that can be eliminated:

1. **4,377 source map files** taking up significant space (estimated 50-80MB)
2. **~600 language syntax highlighter definitions** bundled (estimated 30-50MB)
3. **3,847 core-js polyfill files** that modern Electron doesn't need (estimated 10-20MB)
4. **33 JetBrains plugin JAR files** (~12MB) that shouldn't be in asar at all
5. **817 libphonenumber locale files** when we only need basic phone detection (estimated 5-10MB)

**Estimated achievable reduction:** 100-180MB (25-45% reduction)

## Top 10 Largest Packages by File Count

| Files | Package | Purpose | Status |
|-------|---------|---------|--------|
| 3,847 | core-js | ES polyfills | **REMOVABLE** - Electron has modern JS |
| 1,996 | react-syntax-highlighter | Code highlighting | **OPTIMIZABLE** - Too many languages |
| 1,755 | @nimbalyst | Our code | Necessary |
| 1,708 | openai | OpenAI SDK | Necessary |
| 817 | libphonenumber-js | Phone validation | **OPTIMIZABLE** - Only need basic detection |
| 789 | rexical | Lexical editor | Necessary |
| 728 | prismjs | Syntax highlighting | **OPTIMIZABLE** - 298 languages bundled |
| 670 | @anthropic-ai | Claude SDK | **PROBLEMATIC** - Includes JARs |
| 650 | lodash-es | Utilities | Necessary (small overhead) |
| 613 | langium | Language toolkit | **INVESTIGATE** - May be dependency bloat |

## Major Issues Identified

### 1. Source Maps in Production (HIGH PRIORITY)

**Finding:** 4,377 `.map` files bundled in production asar
**Size impact:** Estimated 50-80MB
**Examples:**
- All Anthropic SDK files have `.d.ts.map`, `.d.mts.map`, `.js.map`, `.mjs.map`
- Every node_modules package includes source maps

**Recommendation:**
- Exclude `*.map` files from electron-builder `files` pattern
- Configure Vite to not generate source maps for production
- Add to package.json build config:
  ```json
  "files": [
    "out/**/*",
    "!out/**/*.map",
    "node_modules/**/*",
    "!node_modules/**/*.map"
  ]
  ```

**Expected savings:** 50-80MB

### 2. Excessive Syntax Highlighting Languages (HIGH PRIORITY)

**Finding:**
- react-syntax-highlighter: 197 highlight.js languages + 300 Prism languages = 497 language files
- prismjs: 298 language component files (both .js and .min.js versions)
- Total: ~600 language definition files

**Size impact:** Estimated 30-50MB

**Actual usage:** We use react-syntax-highlighter in exactly one place:
- `packages/runtime/src/ui/AgentTranscript/components/MarkdownRenderer.tsx`

**Recommendation:**
- Replace react-syntax-highlighter with a lighter alternative:
    - Option 1: Use Prism Light with only essential languages (js, ts, python, bash, markdown, json)
    - Option 2: Use react-markdown with remark-prism plugin and custom language set
    - Option 3: Use CodeMirror's language support (already have it for editor)

**Expected savings:** 35-45MB

### 3. core-js Polyfills Not Needed (MEDIUM PRIORITY)

**Finding:** 3,847 core-js polyfill files bundled

**Why unnecessary:**
- Electron 37 uses Chromium 128
- Chromium 128 has full ES2023 support
- All polyfills are redundant in Electron environment

**Recommendation:**
- Add core-js to electron-builder ignore list
- Configure Vite/Babel to not bundle polyfills for Electron target
- Set browserslist target to `electron >= 37`

**Expected savings:** 10-20MB

### 4. JetBrains Plugin JARs in ASAR (HIGH PRIORITY)

**Finding:** 33 JAR files from claude-code-jetbrains-plugin in app.asar
- These are removed from app.asar.unpacked by afterSign.js
- But they're still in the asar file itself (~12MB)

**Files:**
```
/node_modules/@anthropic-ai/claude-agent-sdk/vendor/claude-code-jetbrains-plugin/lib/*.jar
```

**Recommendation:**
- Add JetBrains plugin to asarUnpack pattern
- Remove entire vendor/claude-code-jetbrains-plugin directory in afterPack (before asar creation)
- We don't use the JetBrains plugin - only ripgrep from the vendor directory

**Expected savings:** 12MB

### 5. libphonenumber-js Over-inclusion (MEDIUM PRIORITY)

**Finding:** 817 libphonenumber-js files bundled

**Actual usage:** Only used in analytics-utils.ts for PII detection:
```typescript
import {findPhoneNumbersInText} from "libphonenumber-js/max";
```

**Problem:** Using `/max` import pulls in all country metadata

**Recommendation:**
- Switch to basic import: `import {findPhoneNumbersInText} from "libphonenumber-js";`
- Or use simple regex for US phone numbers (sufficient for PII detection)
- We don't need accurate phone parsing - just detection

**Expected savings:** 5-10MB

### 6. esbuild in Production (MEDIUM PRIORITY)

**Finding:** esbuild package (9.5MB) bundled in production

**Actual usage:** Zero runtime usage detected
- Used only in build scripts (build-worker.js)
- Not imported in any src/ files

**Recommendation:**
- Move esbuild to devDependencies
- Add to electron-builder ignore patterns
- Ensure worker build happens before production build

**Expected savings:** 9.5MB

### 7. Duplicate/Unused Dependencies (LOW-MEDIUM PRIORITY)

**Packages to audit:**

**langium (613 files)** - Language toolkit for DSLs
- Check if this is transitive dependency bloat
- May be pulled in by Mermaid or other diagram library
- If not directly used, consider replacing the parent dependency

**abort-controller** - Built into Node.js 15+, Electron uses Node 20
- Can be safely removed

**form-data-encoder + formdata-node** - May be redundant with modern fetch
- Node 18+ has native FormData
- Check if node-fetch still needs these

**agentkeepalive** - HTTP keep-alive agent
- Check if OpenAI SDK actually benefits from this
- May not be needed with modern connection pooling

## Largest Compiled Assets (Renderer)

These are already code-split, but worth noting:

| Size | File | Purpose |
|------|------|---------|
| 4.7MB | index-DqpLYuuV.js | Main app bundle |
| 3.4MB | ExcalidrawModal-DFUjng6J.js | Drawing component |
| 935KB | cytoscape.esm-CFnMqlNF.js | Diagram layout |
| 811KB | mermaid.core-Dm2g2gky.js | Mermaid diagrams |
| 636KB | standalone-BYek_t3Q.js | Unknown |
| 477KB | katex-B7AUlPkp.js | Math rendering |

These are acceptable as they're code-split and lazy-loaded. The main bundle (4.7MB) should be analyzed for tree-shaking opportunities.

## Implementation Priority

### Phase 1: Quick Wins (Low Risk, High Impact)
1. Remove source maps from production - **50-80MB saved**
2. Remove JetBrains JARs from asar - **12MB saved**
3. Move esbuild to devDependencies - **9.5MB saved**

**Total Phase 1 savings:** ~70-100MB

### Phase 2: Dependency Optimization (Medium Risk, High Impact)
1. Replace react-syntax-highlighter with lighter alternative - **35-45MB saved**
2. Switch libphonenumber to basic import - **5-10MB saved**
3. Exclude core-js polyfills - **10-20MB saved**

**Total Phase 2 savings:** ~50-75MB

### Phase 3: Dependency Cleanup (Low Risk, Medium Impact)
1. Remove abort-controller, form-data-encoder, formdata-node
2. Audit langium usage
3. Review agentkeepalive necessity

**Total Phase 3 savings:** ~5-10MB

## Total Expected Impact

**Conservative estimate:** 125MB reduction (30% smaller asar)
**Optimistic estimate:** 185MB reduction (45% smaller asar)

Combined with the 60MB savings from the main optimization plan (ripgrep + unpacked optimizations), total app size could drop from **257MB to ~100-130MB** (60% reduction).

## Verification Steps

After each phase:
1. Build production bundle
2. Check asar size: `du -sh app.asar`
3. List asar contents: `npx asar list app.asar | grep <pattern>`
4. Test app functionality
5. Check bundle with: `npx asar extract app.asar /tmp/asar-test`

## Implementation Notes

### Exclude Source Maps
In `packages/electron/package.json`:
```json
{
  "build": {
    "files": [
      "out/**/*",
      "!out/**/*.map",
      "node_modules/**/*",
      "!node_modules/**/*.map",
      "!node_modules/**/*.d.ts.map",
      "!node_modules/**/*.d.mts.map"
    ]
  }
}
```

### Configure Vite to Skip Source Maps
In `packages/electron/electron.vite.config.ts`:
```typescript
export default {
  renderer: {
    build: {
      sourcemap: false // or 'hidden' for external maps
    }
  }
}
```

### Remove JetBrains Plugin
In `packages/electron/build/afterPack.js` (before asar creation):
```javascript
const jetbrainsPath = path.join(unpackedPath, '@anthropic-ai/claude-agent-sdk/vendor/claude-code-jetbrains-plugin');
if (fs.existsSync(jetbrainsPath)) {
  fs.rmSync(jetbrainsPath, { recursive: true });
}
```

## Risk Assessment

**Low Risk:**
- Source map removal (no functional impact)
- JetBrains JAR removal (not used)
- esbuild removal (build-time only)
- core-js removal (Electron has native support)

**Medium Risk:**
- Syntax highlighter replacement (requires code changes, testing)
- libphonenumber optimization (verify PII detection still works)

**Testing Requirements:**
- All E2E tests must pass
- Manual test: Code blocks in AI transcript render correctly
- Manual test: Analytics PII detection still works
- Visual regression testing for code highlighting
