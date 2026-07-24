import { describe, expect, it } from 'vitest';
import { deriveCollabDocumentType } from '../collabDocumentType';

describe('deriveCollabDocumentType', () => {
  it('detects markdown files', () => {
    const registry = {
      findMatchForFile: () => undefined,
    };

    expect(deriveCollabDocumentType('Harness.md', registry)).toBe('markdown');
    expect(deriveCollabDocumentType('Harness.markdown', registry)).toBe('markdown');
  });

  it('preserves the full registered custom-editor suffix', () => {
    const registry = {
      findMatchForFile: () => ({
        key: '.mockup.html',
        registration: { collaboration: { supported: true } },
      }),
    };

    expect(deriveCollabDocumentType('deep-dive.mockup.html', registry as any)).toBe('mockup.html');
  });

  it('rejects non-collaborative custom editors', () => {
    const registry = {
      findMatchForFile: () => ({
        key: '.foo',
        registration: { collaboration: { supported: false } },
      }),
    };

    expect(deriveCollabDocumentType('test.foo', registry as any)).toBeNull();
  });

  it('lets a collab custom editor whose suffix ends in .md win over the markdown fallback', () => {
    // `.calc.md` ends in `.md` but must resolve to the calc-sheets editor, not
    // be shadowed by the generic markdown shortcut (which would mis-route it to
    // Lexical). The registry does longest-suffix matching, so it returns
    // `.calc.md` for this file.
    const registry = {
      findMatchForFile: () => ({
        key: '.calc.md',
        registration: { collaboration: { supported: true } },
      }),
    };

    expect(deriveCollabDocumentType('budget.calc.md', registry as any)).toBe('calc.md');
  });

  it('still resolves plain markdown to markdown even if a non-collab editor claims .md', () => {
    // A registry match keyed exactly on `.md` must never override the built-in
    // markdown type.
    const registry = {
      findMatchForFile: () => ({
        key: '.md',
        registration: { collaboration: { supported: true } },
      }),
    };

    expect(deriveCollabDocumentType('notes.md', registry as any)).toBe('markdown');
  });
});
