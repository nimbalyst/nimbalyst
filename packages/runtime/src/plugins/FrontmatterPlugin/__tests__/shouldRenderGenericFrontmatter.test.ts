// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { shouldRenderGenericFrontmatter } from '../GenericFrontmatterHeader';
import { shouldRenderTrackerHeader } from '../../TrackerPlugin/documentHeader/TrackerDocumentHeader';

const fm = (body: string): string => `---\n${body}\n---\n\n# Doc\n\nSome text.\n`;

/**
 * A markdown document must be claimed by exactly one header provider. Claimed
 * by neither is the #1357 failure: both providers decline and the document
 * falls through to the raw text editor, silently.
 */
function claimedBy(content: string, path = 'doc.md'): 'tracker' | 'generic' | 'nobody' {
  if (shouldRenderTrackerHeader(content, path)) return 'tracker';
  if (shouldRenderGenericFrontmatter(content, path)) return 'generic';
  return 'nobody';
}

describe('generic frontmatter header stands down only for a real tracker doc (#1357)', () => {
  // The regression. Every tracker branch requires the status key to hold an
  // object, so a scalar leaves the tracker header out -- and the generic header
  // used to step aside anyway.
  const scalarKeys = [
    'planStatus: draft',
    'decisionStatus: open',
    'automationStatus: active',
    'trackerStatus: open',
    'bugStatus: triage',
    'taskStatus: todo',
    'ideaStatus: raw',
  ];

  for (const line of scalarKeys) {
    it(`renders the generic card for a scalar "${line.split(':')[0]}"`, () => {
      expect(claimedBy(fm(`title: Doc\n${line}`))).toBe('generic');
    });
  }

  // The control that must go the other way: object form is a real tracker
  // document, and the generic header must still stand down. Asserted against
  // the gate directly rather than through `claimedBy`, which checks the tracker
  // header first and would report 'tracker' no matter what this gate returned.
  // DocumentHeaderContainer renders *every* matching provider (priority only
  // orders them), so a generic header that fails to stand down stacks a second
  // card under the tracker UI.
  const objectKeys = [
    ['planStatus', 'planStatus:\n  status: draft\n  owner: me'],
    ['decisionStatus', 'decisionStatus:\n  status: open'],
    ['automationStatus', 'automationStatus:\n  status: active'],
    ['bugStatus', 'bugStatus:\n  status: triage'],
    ['taskStatus', 'taskStatus:\n  status: todo'],
    ['ideaStatus', 'ideaStatus:\n  status: raw'],
  ] as const;

  for (const [name, block] of objectKeys) {
    it(`stands down for an object ${name}`, () => {
      const content = fm(`title: Doc\n${block}`);
      expect(shouldRenderTrackerHeader(content, 'doc.md')).toBe(true);
      expect(shouldRenderGenericFrontmatter(content, 'doc.md')).toBe(false);
    });
  }

  it('stands down for a canonical trackerStatus block carrying a type', () => {
    const content = fm('title: Doc\ntrackerStatus:\n  type: plan');
    expect(shouldRenderTrackerHeader(content, 'doc.md')).toBe(true);
    expect(shouldRenderGenericFrontmatter(content, 'doc.md')).toBe(false);
  });

  it('still renders for ordinary frontmatter with no status key', () => {
    expect(claimedBy(fm('title: Notes\ntags: [a, b]'))).toBe('generic');
  });

  it('still declines non-markdown files', () => {
    // Standalone YAML is out of scope by design: `---` means other things in
    // .astro and friends, so the gate is extension-bound.
    expect(shouldRenderGenericFrontmatter('title: Notes\n', 'config.yaml')).toBe(false);
    expect(shouldRenderGenericFrontmatter(fm('title: Notes'), 'notes.astro')).toBe(false);
  });

  it('still declines a document with no frontmatter at all', () => {
    expect(shouldRenderGenericFrontmatter('# Just a heading\n', 'doc.md')).toBe(false);
  });

  it('still surfaces the error banner for malformed frontmatter', () => {
    expect(shouldRenderGenericFrontmatter('---\ntitle: [unclosed\n---\n\nbody\n', 'doc.md')).toBe(true);
  });
});
