import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * TabContent mounts each tab in its own React root (createRoot per tab),
 * wrapped only in JotaiProvider. React context does NOT cross roots, so any
 * component in those trees that calls useDialog() throws
 * "useDialog must be used within a DialogProvider" at mount and the tab
 * crashes to TabEditorErrorBoundary (observed live 2026-07-15 for every
 * shared-document tab). Cross-root dialog access must go through the
 * module-level dialogRef escape hatch instead.
 *
 * This scans the entry components TabContent renders. It cannot see
 * transitive imports, but it catches the recurring direct mistake.
 */
const SEPARATE_ROOT_ENTRY_COMPONENTS = [
  '../TabEditor/CollaborativeTabEditor.tsx',
  '../TabEditor/TabEditor.tsx',
  '../AgentMode/TrackerResourceEditor.tsx',
];

describe('components mounted in TabContent separate React roots', () => {
  it.each(SEPARATE_ROOT_ENTRY_COMPONENTS)(
    '%s does not call useDialog (context cannot cross roots; use dialogRef)',
    (relativePath) => {
      const source = readFileSync(
        resolve(__dirname, '..', relativePath),
        'utf8',
      );
      expect(source).not.toMatch(/\buseDialog\s*\(/);
    },
  );
});
