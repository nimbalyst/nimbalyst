import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyMatchPath, fuzzyFilterDocuments } from '../fuzzyMatch';

describe('fuzzyMatch', () => {
  describe('exact substring matching', () => {
    it('matches exact substring', () => {
      const result = fuzzyMatch('bugs', 'tracker-bugs.md');
      expect(result.matches).toBe(true);
      expect(result.score).toBeGreaterThan(0.5);
    });

    it('matches prefix with higher score', () => {
      const prefixResult = fuzzyMatch('track', 'tracker-bugs.md');
      const midResult = fuzzyMatch('bugs', 'tracker-bugs.md');
      expect(prefixResult.matches).toBe(true);
      expect(midResult.matches).toBe(true);
      expect(prefixResult.score).toBeGreaterThan(midResult.score);
    });

    it('is case insensitive', () => {
      const result = fuzzyMatch('BUGS', 'tracker-bugs.md');
      expect(result.matches).toBe(true);
    });
  });

  describe('CamelCase matching', () => {
    it('matches CamelCase abbreviation', () => {
      const result = fuzzyMatch('ClaCoPro', 'ClaudeCodeProvider.tsx');
      expect(result.matches).toBe(true);
      expect(result.score).toBeGreaterThan(0.6);
    });

    it('matches partial CamelCase', () => {
      const result = fuzzyMatch('CoPro', 'ClaudeCodeProvider.tsx');
      expect(result.matches).toBe(true);
    });

    it('returns correct matched indices for CamelCase', () => {
      const result = fuzzyMatch('ClaCoPro', 'ClaudeCodeProvider.tsx');
      expect(result.matches).toBe(true);
      // Should match: Cla(ude)Co(de)Pro(vider)
      // Indices: 0,1,2 for "Cla", 6,7 for "Co", 10,11,12 for "Pro"
      expect(result.matchedIndices).toContain(0); // C
      expect(result.matchedIndices).toContain(6); // C of Code
      expect(result.matchedIndices).toContain(10); // P of Provider
    });

    it('requires segments to match in order', () => {
      const result = fuzzyMatch('ProCla', 'ClaudeCodeProvider.tsx');
      expect(result.matches).toBe(false);
    });

    it('handles two-letter abbreviation', () => {
      const result = fuzzyMatch('CC', 'ClaudeCode.tsx');
      expect(result.matches).toBe(true);
    });
  });

  describe('delimiter-separated matching', () => {
    it('matches dash-separated prefixes', () => {
      const result = fuzzyMatch('tra-bug', 'tracker-bugs.md');
      expect(result.matches).toBe(true);
      expect(result.score).toBeGreaterThan(0.55);
    });

    it('matches dot-separated prefixes', () => {
      const result = fuzzyMatch('ses.file', 'session-files.ts');
      expect(result.matches).toBe(true);
      expect(result.score).toBeGreaterThan(0.55);
    });

    it('matches underscore-separated prefixes', () => {
      const result = fuzzyMatch('my_comp', 'my_component.tsx');
      expect(result.matches).toBe(true);
      expect(result.score).toBeGreaterThan(0.55);
    });

    it('scores higher than fuzzy subsequence for same target', () => {
      const delimiterResult = fuzzyMatch('tra-bug', 'tracker-bugs.md');
      // Compare with a pure subsequence match of equivalent scattered chars
      const subsequenceResult = fuzzyMatch('trbg', 'tracker-bugs.md');
      expect(delimiterResult.score).toBeGreaterThan(subsequenceResult.score);
    });

    it('requires segments to match in order', () => {
      const result = fuzzyMatch('bug-tra', 'tracker-bugs.md');
      // "bug" does not match "tracker" as prefix, so delimiter match fails.
      // May still match via fuzzy subsequence but with a low score.
      // The delimiter strategy specifically should not match out-of-order.
      expect(result.score).toBeLessThanOrEqual(0.5);
    });

    it('does not activate for single-segment queries without delimiters', () => {
      // Single word without delimiters should use substring/subsequence, not delimiter match
      const result = fuzzyMatch('tracker', 'tracker-bugs.md');
      expect(result.matches).toBe(true);
      // Should match via substring, not delimiter
      expect(result.score).toBeGreaterThan(0.5);
    });

    it('matches mixed delimiter types against target', () => {
      const result = fuzzyMatch('elec-rend', 'electron-renderer');
      expect(result.matches).toBe(true);
      expect(result.score).toBeGreaterThan(0.55);
    });
  });

  describe('fuzzy subsequence matching', () => {
    it('matches scattered characters in order', () => {
      const result = fuzzyMatch('trbg', 'tracker-bugs.md');
      expect(result.matches).toBe(true);
      expect(result.score).toBeLessThan(0.5); // Lower score for fuzzy match
    });

    it('fails when characters are out of order', () => {
      const result = fuzzyMatch('bgtr', 'tracker-bugs.md');
      expect(result.matches).toBe(false);
    });
  });

  describe('empty and edge cases', () => {
    it('returns match for empty query', () => {
      const result = fuzzyMatch('', 'anything.md');
      expect(result.matches).toBe(true);
      expect(result.score).toBe(1);
    });

    it('returns no match for empty target', () => {
      const result = fuzzyMatch('query', '');
      expect(result.matches).toBe(false);
    });
  });
});

describe('fuzzyMatchPath', () => {
  it('prefers filename matches over path matches', () => {
    const filenameMatch = fuzzyMatchPath('Provider', 'packages/ai/server/providers/ClaudeProvider.ts');
    const pathMatch = fuzzyMatchPath('packages', 'packages/ai/server/providers/ClaudeProvider.ts');

    expect(filenameMatch.matches).toBe(true);
    expect(pathMatch.matches).toBe(true);
    // Both match, but filename match should score higher
    expect(filenameMatch.score).toBeGreaterThan(pathMatch.score);
  });

  it('matches against full path when filename does not match', () => {
    const result = fuzzyMatchPath('electron', 'packages/electron/src/main/index.ts');
    expect(result.matches).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });
});

describe('fuzzyFilterDocuments', () => {
  const documents = [
    { name: 'ClaudeCodeProvider.tsx', path: 'packages/runtime/src/ai/server/providers/ClaudeCodeProvider.tsx' },
    { name: 'ClaudePanel.tsx', path: 'packages/electron/src/renderer/components/AIModels/panels/ClaudePanel.tsx' },
    { name: 'tracker-bugs.md', path: 'packages/electron/assets/tracker-bugs.md' },
    { name: 'Bugs.md', path: 'nimbalyst-local/Bugs.md' },
    { name: 'OpenAIProvider.tsx', path: 'packages/runtime/src/ai/server/providers/OpenAIProvider.tsx' },
  ];

  it('returns all documents for empty query', () => {
    const results = fuzzyFilterDocuments(documents, '');
    expect(results.length).toBe(5);
  });

  it('filters by CamelCase abbreviation', () => {
    const results = fuzzyFilterDocuments(documents, 'ClaCoPro');
    expect(results.length).toBe(1);
    expect(results[0].item.name).toBe('ClaudeCodeProvider.tsx');
  });

  it('filters by substring', () => {
    const results = fuzzyFilterDocuments(documents, 'bugs');
    expect(results.length).toBe(2);
    expect(results.map(r => r.item.name)).toContain('tracker-bugs.md');
    expect(results.map(r => r.item.name)).toContain('Bugs.md');
  });

  it('ranks results by score', () => {
    const results = fuzzyFilterDocuments(documents, 'Claude');
    expect(results.length).toBeGreaterThan(0);
    // Results should be sorted by score (highest first)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].match.score).toBeGreaterThanOrEqual(results[i].match.score);
    }
  });

  it('respects limit parameter', () => {
    const results = fuzzyFilterDocuments(documents, 'Panel', 1);
    expect(results.length).toBe(1);
  });
});
