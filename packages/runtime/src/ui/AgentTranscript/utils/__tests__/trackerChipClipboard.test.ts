import { describe, it, expect } from 'vitest';

import { serializeSelectionWithTrackerChips } from '../trackerChipClipboard';

/**
 * Build a chip matching the real TrackerReferenceChip DOM: an icon, the issue
 * key, a title, and a status badge, all nested under `.tracker-reference-chip`.
 * The title/status text is exactly the noise that must NOT end up on the
 * clipboard — only the issue key should.
 */
function chip(
  key: string,
  opts: { title?: string; status?: string; withAttr?: boolean } = {},
): string {
  const { title = 'Some title', status = 'In Progress', withAttr = true } = opts;
  const attr = withAttr ? ` data-issue-key="${key}"` : '';
  return (
    `<span class="tracker-reference-chip"${attr} data-status="in-progress">` +
    `<span class="material-symbols-outlined tracker-reference-chip-type-icon">bug_report</span>` +
    `<span class="tracker-reference-chip-key">${key}</span>` +
    `<span class="tracker-reference-chip-title">${title}</span>` +
    `<span class="tracker-reference-chip-status">${status}</span>` +
    `</span>`
  );
}

/** Mirror a real Cmd+C: clone the contents of a selection over `html`. */
function selectionFragment(html: string): DocumentFragment {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  const range = document.createRange();
  range.selectNodeContents(container);
  const fragment = range.cloneContents();
  container.remove();
  return fragment;
}

describe('serializeSelectionWithTrackerChips', () => {
  it('returns null when the selection contains no tracker chips', () => {
    const fragment = selectionFragment('<p>just some ordinary transcript text</p>');
    expect(serializeSelectionWithTrackerChips(fragment)).toBeNull();
  });

  it('copies a single chip as its issue key with the hyphen intact', () => {
    const result = serializeSelectionWithTrackerChips(selectionFragment(chip('NIM-2058')));
    expect(result).not.toBeNull();
    // Regression for the reported "NIM 2058" (space, no hyphen) symptom.
    expect(result!.text).toBe('NIM-2058');
    expect(result!.text).not.toContain('NIM 2058');
    // And the title/status noise inside the chip must not leak out.
    expect(result!.text).not.toContain('In Progress');
    expect(result!.text).not.toContain('Some title');
    // Rich text carries the nimbalyst:// reference so paste can rebuild a chip.
    expect(result!.html).toContain('href="nimbalyst://NIM-2058"');
    expect(result!.html).toContain('>NIM-2058</a>');
  });

  it('keeps both keys and line structure for a bulleted list of chips (reported case)', () => {
    const html =
      '<ul>' +
      `<li>${chip('NIM-1745')} — Make onboarding modes and entry points discoverable <em>(Onboarding)</em></li>` +
      `<li>${chip('NIM-2058')} — Offer a 15-minute learn-by-doing quickstart after onboarding <em>(Tutorial)</em></li>` +
      '</ul>';
    const result = serializeSelectionWithTrackerChips(selectionFragment(html));
    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      'NIM-1745 — Make onboarding modes and entry points discoverable (Onboarding)\n' +
        'NIM-2058 — Offer a 15-minute learn-by-doing quickstart after onboarding (Tutorial)',
    );
    // Both chips resolve to real references in the HTML payload.
    expect(result!.html).toContain('href="nimbalyst://NIM-1745"');
    expect(result!.html).toContain('href="nimbalyst://NIM-2058"');
    // The status badge text is never copied.
    expect(result!.text).not.toContain('In Progress');
  });

  it('falls back to the visible key span when data-issue-key is missing', () => {
    const result = serializeSelectionWithTrackerChips(
      selectionFragment(chip('NIM-9', { withAttr: false })),
    );
    expect(result!.text).toBe('NIM-9');
  });
});
