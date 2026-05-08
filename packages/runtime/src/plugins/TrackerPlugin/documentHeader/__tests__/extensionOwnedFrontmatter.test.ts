import { describe, it, expect } from 'vitest';
import jsyaml from 'js-yaml';
import {
  detectTrackerFromFrontmatter,
  updateTrackerInFrontmatter,
  extractFrontmatter,
} from '../frontmatterUtils';

// Files with an `automationStatus:` block are owned by the automations
// extension. The tracker plugin must detect them as `automation` items and
// must never flatten or rewrite the nested block (NIM-324). These tests pin
// down the contract so the bug cannot regress.

function buildAutomationContent(frontmatter: Record<string, any>, body = '\n# Body\n'): string {
  return `---\n${jsyaml.dump(frontmatter)}---\n${body}`;
}

describe('frontmatterUtils — extension-owned automationStatus', () => {
  describe('detectTrackerFromFrontmatter', () => {
    it('detects automation type from nested automationStatus', () => {
      const content = buildAutomationContent({
        automationStatus: {
          id: 'daily-build',
          title: 'Daily Build',
          enabled: true,
          schedule: { type: 'daily', time: '09:00' },
          output: { mode: 'new-file', location: 'out/' },
          runCount: 7,
          lastRun: '2026-04-18',
        },
      });

      const detected = detectTrackerFromFrontmatter(content);

      expect(detected?.type).toBe('automation');
      expect(detected?.data.id).toBe('daily-build');
      expect(detected?.data.runCount).toBe(7);
    });

    it('prefers fresh nested fields over stale top-level duplicates', () => {
      // Simulates a file that was previously corrupted by the old flattening
      // code: top-level fields are stale, nested fields are fresh.
      const content = buildAutomationContent({
        // Stale top-level duplicates from the old bug:
        lastRun: '2026-04-15',
        runCount: 3,
        // Top-level tracker fields the nested block does not own:
        status: 'active',
        tags: ['ai'],
        // Fresh nested data managed by the automations extension:
        automationStatus: {
          id: 'daily-build',
          title: 'Daily Build',
          enabled: true,
          schedule: { type: 'daily', time: '09:00' },
          output: { mode: 'new-file', location: 'out/' },
          runCount: 7,
          lastRun: '2026-04-18',
        },
      });

      const detected = detectTrackerFromFrontmatter(content);

      expect(detected?.data.runCount).toBe(7);
      expect(detected?.data.lastRun).toBe('2026-04-18');
      expect(detected?.data.status).toBe('active');
      expect(detected?.data.tags).toEqual(['ai']);
    });
  });

  describe('updateTrackerInFrontmatter', () => {
    it('preserves the nested automationStatus block byte-for-byte', () => {
      const nested = {
        id: 'daily-build',
        title: 'Daily Build',
        enabled: true,
        schedule: { type: 'daily', time: '09:00' },
        output: { mode: 'new-file', location: 'out/' },
        runCount: 7,
        lastRun: '2026-04-18',
      };
      const content = buildAutomationContent({ automationStatus: nested, status: 'active' });

      const updated = updateTrackerInFrontmatter(content, 'automation', { status: 'paused' });
      const fm = extractFrontmatter(updated);

      expect(fm?.automationStatus).toEqual(nested);
    });

    it('cleans up stale top-level duplicates of nested fields', () => {
      const content = buildAutomationContent({
        lastRun: '2026-04-15',
        runCount: 3,
        title: 'Stale Title',
        automationStatus: {
          id: 'daily-build',
          title: 'Daily Build',
          enabled: true,
          schedule: { type: 'daily', time: '09:00' },
          output: { mode: 'new-file', location: 'out/' },
          runCount: 7,
          lastRun: '2026-04-18',
        },
      });

      const updated = updateTrackerInFrontmatter(content, 'automation', {});
      const fm = extractFrontmatter(updated);

      expect(fm).not.toHaveProperty('lastRun');
      expect(fm).not.toHaveProperty('runCount');
      // `title` lives in the nested block, so the top-level duplicate must be removed.
      expect(fm).not.toHaveProperty('title');
    });

    it('applies user updates to top-level tracker fields the nested block does not own', () => {
      const content = buildAutomationContent({
        automationStatus: {
          id: 'daily-build',
          title: 'Daily Build',
          enabled: true,
          schedule: { type: 'daily', time: '09:00' },
          output: { mode: 'new-file', location: 'out/' },
          runCount: 0,
        },
      });

      const updated = updateTrackerInFrontmatter(content, 'automation', {
        status: 'paused',
        tags: ['ops'],
      });
      const fm = extractFrontmatter(updated);

      expect(fm?.status).toBe('paused');
      expect(fm?.tags).toEqual(['ops']);
    });

    it('drops updates targeting nested-owned fields rather than recreating duplicates', () => {
      const content = buildAutomationContent({
        automationStatus: {
          id: 'daily-build',
          title: 'Daily Build',
          enabled: true,
          schedule: { type: 'daily', time: '09:00' },
          output: { mode: 'new-file', location: 'out/' },
          runCount: 7,
          lastRun: '2026-04-18',
        },
      });

      const updated = updateTrackerInFrontmatter(content, 'automation', {
        // The scheduler is the only writer for these. A stray tracker write
        // must not resurrect the flatten-and-stale bug.
        runCount: 999,
        lastRun: '1970-01-01',
      });
      const fm = extractFrontmatter(updated);

      expect(fm).not.toHaveProperty('runCount');
      expect(fm).not.toHaveProperty('lastRun');
      expect((fm?.automationStatus as Record<string, any>).runCount).toBe(7);
      expect((fm?.automationStatus as Record<string, any>).lastRun).toBe('2026-04-18');
    });

    it('writes trackerStatus.type without removing the nested block', () => {
      const content = buildAutomationContent({
        automationStatus: {
          id: 'daily-build',
          title: 'Daily Build',
          enabled: true,
          schedule: { type: 'daily', time: '09:00' },
          output: { mode: 'new-file', location: 'out/' },
          runCount: 0,
        },
      });

      const updated = updateTrackerInFrontmatter(content, 'automation', {});
      const fm = extractFrontmatter(updated);

      expect(fm?.trackerStatus).toEqual({ type: 'automation' });
      expect(fm).toHaveProperty('automationStatus');
    });
  });

  // CRLF tolerance regression coverage for nimbalyst#68. On Windows with
  // `git config core.autocrlf=true`, files arrive with `\r\n` line endings.
  // The frontmatter regexes used to require bare `\n`, so the entire
  // automations / Tracker pipeline silently treated the files as
  // frontmatter-less. These tests pin `\r?\n` tolerance.
  describe('CRLF line endings', () => {
    function buildCrlfContent(frontmatter: Record<string, any>, body = '\n# Body\n'): string {
      // jsyaml emits LF; build the wrapper with explicit CRLF and replace
      // the YAML body's LFs with CRLFs to mirror what git delivers on Windows.
      const yaml = jsyaml.dump(frontmatter).replace(/\n/g, '\r\n');
      return `---\r\n${yaml}---\r\n${body}`;
    }

    it('extractFrontmatter parses CRLF frontmatter', () => {
      const content = buildCrlfContent({ title: 'Windows file', priority: 'high' });
      const fm = extractFrontmatter(content);
      expect(fm).not.toBeNull();
      expect(fm?.title).toBe('Windows file');
      expect(fm?.priority).toBe('high');
    });

    it('detectTrackerFromFrontmatter recognises automationStatus in CRLF files', () => {
      const content = buildCrlfContent({
        automationStatus: {
          id: 'daily-build',
          title: 'Daily Build',
          enabled: true,
          schedule: { type: 'daily', time: '09:00' },
          output: { mode: 'new-file', location: 'out/' },
        },
      });
      const detected = detectTrackerFromFrontmatter(content);
      expect(detected?.type).toBe('automation');
      expect(detected?.data.id).toBe('daily-build');
    });

    it('updateTrackerInFrontmatter still works on CRLF input', () => {
      const content = buildCrlfContent({
        automationStatus: {
          id: 'daily-build',
          title: 'Daily Build',
          enabled: true,
          schedule: { type: 'daily', time: '09:00' },
          output: { mode: 'new-file', location: 'out/' },
        },
      });
      const updated = updateTrackerInFrontmatter(content, 'automation', {});
      const fm = extractFrontmatter(updated);
      expect(fm?.trackerStatus).toEqual({ type: 'automation' });
      expect(fm).toHaveProperty('automationStatus');
    });
  });
});
