// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));

import { FrontmatterProperties } from '../FrontmatterProperties';

const DOC = '---\nid: 01ABC\norder: 1000\nstatus: current\nsummary: What it is\n---\n\n# Home\n';

function setup(content = DOC) {
  let current = content;
  const onContentChange = vi.fn((next: string) => { current = next; });
  render(<FrontmatterProperties getContent={() => current} contentVersion={0} onContentChange={onContentChange} />);
  return { onContentChange, content: () => current };
}

describe('FrontmatterProperties', () => {
  it('keeps agent fields behind a disclosure and writes an edit once, on blur', () => {
    const { onContentChange, content } = setup();
    expect(screen.queryByDisplayValue('01ABC')).toBeNull();
    fireEvent.click(screen.getByText('2 more: id, order'));
    screen.getByDisplayValue('01ABC');

    const summary = screen.getByDisplayValue('What it is');
    fireEvent.change(summary, { target: { value: 'What UserCurrent is' } });
    expect(onContentChange).not.toHaveBeenCalled();
    fireEvent.blur(summary);
    expect(onContentChange).toHaveBeenCalledTimes(1);
    expect(content()).toContain('summary: What UserCurrent is');
    expect(content()).toContain('# Home');
  });

  it('adds a property and shows it without the host re-reading', () => {
    const { content } = setup();
    fireEvent.click(screen.getByText('Add property'));
    const input = screen.getByPlaceholderText('Property name');
    fireEvent.change(input, { target: { value: 'owner' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(content()).toMatch(/owner: ''/);
    screen.getByText('owner');
  });

  it('shows a parse error instead of fields', () => {
    setup('---\nstatus: [unclosed\n---\n');
    screen.getByText('Invalid frontmatter');
  });
});
