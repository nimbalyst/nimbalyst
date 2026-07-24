import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DiffViewer } from '../DiffViewer';

describe('DiffViewer', () => {
  // Regression for NIM-1672: rendering diff lines via a helper that called
  // React.useState broke the Rules of Hooks. When a re-render produced a
  // different number of diff lines than the previous render, React threw
  // "Rendered more hooks than during the previous render." This exercises that
  // exact transition and must not throw.
  it('survives a re-render that changes the diff-line count', () => {
    const twoLineEdit = {
      replacements: [
        { oldText: 'line one\nline two', newText: 'line one changed\nline two changed' },
      ],
    };
    const oneLineEdit = {
      replacements: [
        { oldText: 'single', newText: 'single changed' },
      ],
    };

    const { rerender } = render(<DiffViewer edit={twoLineEdit} />);
    // Re-render with fewer diff lines — previously this changed DiffViewer's
    // hook count and crashed.
    expect(() => rerender(<DiffViewer edit={oneLineEdit} />)).not.toThrow();
    // And back up again.
    expect(() => rerender(<DiffViewer edit={twoLineEdit} />)).not.toThrow();
  });

  it('renders multiple replacements without a hooks mismatch', () => {
    const edit = {
      replacements: [
        { oldText: 'a\nb\nc', newText: 'a2\nb2\nc2' },
        { oldText: 'x', newText: 'y' },
      ],
    };
    const single = { old_string: 'hello', new_string: 'goodbye' };

    const { rerender, container } = render(<DiffViewer edit={edit} />);
    expect(container.querySelectorAll('.diff-line').length).toBeGreaterThan(0);
    // Switch to the single old_string/new_string path (different hook count).
    expect(() => rerender(<DiffViewer edit={single} />)).not.toThrow();
  });
});
