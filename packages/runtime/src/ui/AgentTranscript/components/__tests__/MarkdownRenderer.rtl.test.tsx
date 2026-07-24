import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { RtlTranscriptHost } from '../../../../../../extensions/rtl-support/src/RtlTranscriptHost';
import { _resetTranscriptMarkdownContributionsForTests } from '../../contributions/TranscriptMarkdownContributions';
import { MarkdownRenderer } from '../MarkdownRenderer';

const RTL_SETTINGS_KEY = 'nimbalyst.rtl-support.settings';

describe('MarkdownRenderer RTL contribution integration', () => {
  beforeEach(() => {
    localStorage.removeItem(RTL_SETTINGS_KEY);
    _resetTranscriptMarkdownContributionsForTests();
  });

  afterEach(() => {
    cleanup();
    _resetTranscriptMarkdownContributionsForTests();
    localStorage.removeItem(RTL_SETTINGS_KEY);
  });

  it('preserves core presentation while applying per-block direction', async () => {
    const { container } = render(
      <>
        <RtlTranscriptHost />
        <MarkdownRenderer
          content={'## English heading\n\n> ציטוט בעברית\n\n| כותרת |\n| --- |\n| ערך |'}
        />
      </>,
    );

    await waitFor(() => {
      expect(container.querySelector('h2')?.getAttribute('dir')).toBe('ltr');
    });

    const heading = container.querySelector('h2')!;
    expect(heading.classList.contains('nim-rtl-block')).toBe(true);
    expect(heading.classList.contains('nim-rtl-ltr')).toBe(true);
    expect(heading.style.fontSize).toBe('1.5rem');
    expect(heading.style.fontWeight).toBe('600');
    expect(heading.style.marginTop).toBe('1.25rem');
    expect(heading.style.marginBottom).toBe('0.75rem');

    const blockquote = container.querySelector('blockquote')!;
    expect(blockquote.getAttribute('dir')).toBe('rtl');
    expect(blockquote.classList.contains('nim-rtl-block')).toBe(true);
    expect(blockquote.classList.contains('nim-rtl-rtl')).toBe(true);
    expect(blockquote.style.borderLeft).toBe('4px solid var(--nim-border)');
    expect(blockquote.style.paddingLeft).toBe('1rem');
    expect(blockquote.style.fontStyle).toBe('italic');

    const table = container.querySelector('table')!;
    expect(table.getAttribute('dir')).toBe('rtl');
    expect(table.classList.contains('nim-rtl-table')).toBe(true);
    expect(table.classList.contains('nim-rtl-rtl')).toBe(true);
    expect(table.style.width).toBe('100%');
    expect(table.style.borderCollapse).toBe('collapse');
    expect(table.style.fontSize).toBe('0.875rem');
    expect(table.parentElement?.style.overflowX).toBe('auto');

    const cell = container.querySelector('th')!;
    expect(cell.getAttribute('dir')).toBe('rtl');
    expect(cell.style.padding).toBe('0.75rem');
    expect(cell.style.fontWeight).toBe('600');
  });

  it('isolates mixed-direction text without flattening inline markdown', async () => {
    localStorage.setItem(RTL_SETTINGS_KEY, JSON.stringify({ inlineDetect: true }));

    const { container } = render(
      <>
        <RtlTranscriptHost />
        <MarkdownRenderer content={'Hello **שלום** world'} />
      </>,
    );

    await waitFor(() => {
      expect(container.querySelector('p')?.getAttribute('dir')).toBe('ltr');
    });

    const paragraph = container.querySelector('p')!;
    expect(paragraph.style.marginTop).toBe('0.5rem');
    expect(paragraph.style.marginBottom).toBe('0.5rem');
    expect(paragraph.style.lineHeight).toBe('1.625');
    expect(paragraph.querySelector('strong')).not.toBeNull();
    expect(paragraph.querySelector('strong span[dir="rtl"]')).not.toBeNull();
    expect(paragraph.querySelector('span[dir="ltr"]')).not.toBeNull();
  });
});
