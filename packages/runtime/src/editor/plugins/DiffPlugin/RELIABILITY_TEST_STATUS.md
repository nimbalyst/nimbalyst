# DiffPlugin Reliability - Test Status and Infrastructure

## Summary

This document tracks the status of DiffPlugin reliability testing and telemetry infrastructure added as part of the diff-plugin-reliability.md plan.

## Test Status (as of 2026-04-29 triage)

### Unit Tests
- **Total Tests**: 471
- **Passing**: 463 (98.3%)
- **Skipped**: 8 (1.7%)
- **Failing**: 0
- **Test Files**: 52 passed, 1 skipped (53 total) -- run from repo root with `npx vitest run packages/runtime/src/editor/plugins/DiffPlugin/__tests__`

The previously documented 82 failures (table operations, list formatting, complex formatting, horizontal rules) are no longer reproducible -- they have been fixed by intervening work and the suite is green when run with the root `vitest.config.ts` (which sets `globals: true`). Running vitest from inside the runtime package without the root config produced spurious "describe is not defined" errors -- always run from the repo root.

### Currently Skipped Tests (long-tail bugs, tracked separately)

1. **Link target updates** -- `__tests__/unit/basic/links.test.ts:128`, `:186`
   - "Updates link URL in paragraph" / "Updates link in heading"
   - URL change with unchanged visible text produces no diff
   - Tracked as bug NIM-398

2. **Code block language change** -- `__tests__/unit/basic/code.test.ts:232`
   - "Code block with language change but same content should be replaced"
   - Tracked as bug NIM-398 (same root cause as links: attribute-only changes ignored)

3. **NBSP normalization** -- `__tests__/unit/basic/nbsp-matching.test.ts` (whole suite `describe.skip`)
   - Replacement text-matching does not normalize U+00A0 vs regular space
   - Tracked as bug NIM-399

None of the skipped tests block the current Lexical Diff System Investigation and Rethink plan; they are deliberately deferred long-tail items.

## New Test Infrastructure

### E2E Diff Reliability Tests

**Location**: `packages/electron/e2e/ai/diff-reliability.spec.ts`

**Test Suites**:

1. **Complex Structures** - Tests handling of:
   - Nested lists
   - Table row additions
   - Code block modifications
   - Mixed content type sections
   - Deeply nested structures
   - Whitespace-sensitive changes

2. **Streaming Scenarios** - Tests:
   - Streaming list additions
   - Streaming into middle of document
   - Streaming complex markdown structures
   - Rapid successive streaming operations

3. **Edge Cases** - Tests:
   - Empty document edits
   - Very long lines
   - Special characters in content
   - Formatting boundaries
   - Multiple simultaneous edits

**Usage**:
```bash
# Run all diff reliability tests
cd packages/electron
npx playwright test e2e/ai/diff-reliability.spec.ts

# Run specific test suite
npx playwright test e2e/ai/diff-reliability.spec.ts -g "Complex Structures"
```

### Telemetry System

**Location**: `packages/rexical/src/plugins/DiffPlugin/core/DiffTelemetry.ts`

**Features**:
- Structured event logging for all diff operations
- Performance metrics collection
- Failure mode tracking
- Operation duration tracking
- Warning aggregation
- Export capability for analysis

**Operations Tracked**:
- `text_replacement` - Text-based replacements
- `markdown_diff` - Unified diff application
- `tree_matching` - TreeMatcher operations
- `node_application` - Node-level changes
- `handler_execution` - Handler invocations

**Event Types**:
- `start` - Operation begins
- `success` - Operation completes successfully
- `failure` - Operation fails
- `warning` - Non-fatal issue
- `performance` - Performance metric

**Usage**:

```typescript
import { diffTelemetry } from './core/DiffTelemetry';

// Enable telemetry
diffTelemetry.enable();

// Track an operation
const opId = diffTelemetry.startOperation('text_replacement', {
  replacementCount: 3
});

try {
  // ... perform operation ...
  diffTelemetry.endOperation(opId, 'text_replacement', {
    success: true
  });
} catch (error) {
  diffTelemetry.failOperation(opId, 'text_replacement', error, {
    oldText: '...',
    newText: '...'
  });
}

// Get metrics report
console.log(diffTelemetry.getReport());

// Export for external analysis
const data = diffTelemetry.export();
```

**Console Access** (for debugging):
```javascript
// In browser console or Node
window.__diffTelemetry.getReport()
window.__diffTelemetry.getMetrics()
window.__diffTelemetry.export()
```

## Existing Test Infrastructure

### AI Tool Simulator

**Location**: `packages/electron/e2e/utils/aiToolSimulator.ts`

**Capabilities**:
- Simulate `applyDiff` operations without actual AI
- Simulate streaming content operations
- Test multi-tab scenarios
- Verify content in editor

**Key Functions**:
- `simulateApplyDiff()` - Apply text replacements
- `simulateStreamContent()` - Stream content additions
- `simulateGetDocumentContent()` - Get current content
- `waitForEditorReady()` - Wait for editor initialization

## Next Steps

Based on the diff-plugin-reliability.md plan:

### Phase 1: Investigation (In Progress)
- ✅ Document current test status
- ✅ Create test infrastructure for scenarios
- ✅ Add telemetry system
- 🔄 Analyze failure patterns from existing tests
- 🔄 Categorize failures by root cause

### Phase 2: Solution Design (Upcoming)
- Evaluate solution approaches from plan
- Prototype promising solutions
- Benchmark performance

### Phase 3: Implementation (Upcoming)
- Fix highest-impact failures first (lists, tables)
- Implement fallback mechanisms
- Add pre-validation
- Enhance error recovery

### Phase 4: Validation (Upcoming)
- Run full test suite
- Measure success rate improvement
- Beta testing
- Production monitoring

## Metrics Baseline

**Current State**:
- Success rate: 82% (392/476 tests)
- Critical failures: Table operations, List formatting
- Performance: Not yet measured systematically

**Target State** (from plan):
- Success rate: >99.5%
- Fallback activation: <0.5%
- Zero complete failures
- Test coverage: >90%

## Running Tests

```bash
# Run all DiffPlugin unit tests
cd packages/rexical
npx vitest run src/plugins/DiffPlugin/__tests__

# Run specific test file
npx vitest run src/plugins/DiffPlugin/__tests__/unit/TreeMatcher.test.ts

# Run E2E diff reliability tests
cd packages/electron
npx playwright test e2e/ai/diff-reliability.spec.ts

# Run with telemetry enabled
DIFF_TELEMETRY=true npx vitest run src/plugins/DiffPlugin/__tests__
```

## Debugging

### Enable Telemetry
```typescript
// In code
import { diffTelemetry } from '@nimbalyst/runtime/plugins/DiffPlugin/core/DiffTelemetry';
diffTelemetry.enable();

// Via environment variable
DIFF_TELEMETRY=true npm run test
```

### Access Telemetry Data
```javascript
// Browser console
window.__diffTelemetry.getReport()
window.__diffTelemetry.getMetrics()

// Export for analysis
const data = window.__diffTelemetry.export();
console.log(JSON.stringify(data, null, 2));
```

### Common Issues

**Table operations failing**:
- Check TableDiffHandler implementation
- Verify table row/cell detection logic
- Review markdown-to-node mapping for tables

**List indentation issues**:
- Check ListDiffHandler
- Verify 4-space indentation requirement
- Review list item nesting detection

**Whitespace matching failures**:
- Check normalizeWhitespace() function
- Review trimming logic in text matching
- Verify markdown export preserves structure

## References

- **Plan**: `/plans/diff-plugin-reliability.md`
- **DiffPlugin**: `/packages/rexical/src/plugins/DiffPlugin/`
- **Tests**: `/packages/rexical/src/plugins/DiffPlugin/__tests__/`
- **E2E Tests**: `/packages/electron/e2e/ai/`
- **Telemetry**: `/packages/rexical/src/plugins/DiffPlugin/core/DiffTelemetry.ts`
