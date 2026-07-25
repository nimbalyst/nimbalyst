import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TrackerFavoriteStar } from '../TrackerFavoriteStar';

describe('TrackerFavoriteStar', () => {
  it('toggles without opening, selecting, context-menuing, or dragging its row/card', () => {
    const parentClick = vi.fn();
    const parentDoubleClick = vi.fn();
    const parentContextMenu = vi.fn();
    const parentDragStart = vi.fn();
    const toggle = vi.fn();
    render(
      <div onClick={parentClick} onDoubleClick={parentDoubleClick} onContextMenu={parentContextMenu} onDragStart={parentDragStart}>
        <TrackerFavoriteStar itemId="item-1" isFavorite={false} onToggle={toggle} />
      </div>,
    );
    const star = screen.getByRole('button', { name: 'Add to favorites' });
    fireEvent.click(star);
    fireEvent.doubleClick(star);
    fireEvent.contextMenu(star);
    fireEvent.dragStart(star);

    expect(toggle).toHaveBeenCalledWith('item-1');
    expect(parentClick).not.toHaveBeenCalled();
    expect(parentDoubleClick).not.toHaveBeenCalled();
    expect(parentContextMenu).not.toHaveBeenCalled();
    expect(parentDragStart).not.toHaveBeenCalled();
  });
});
