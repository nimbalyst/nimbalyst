import React from 'react';
import {fireEvent, render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';

import {ImageContextMenu} from '../ImageComponent';

describe('ImageContextMenu', () => {
  it('renders a Copy image action and fires onCopy when clicked', () => {
    const onCopy = vi.fn();
    const onClose = vi.fn();

    render(
      <ImageContextMenu
        pos={{x: 10, y: 20}}
        onCopy={onCopy}
        onClose={onClose}
      />,
    );

    const item = screen.getByRole('menuitem', {name: 'Copy image'});
    fireEvent.click(item);

    expect(onCopy).toHaveBeenCalledTimes(1);
  });
});
