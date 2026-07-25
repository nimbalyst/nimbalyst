// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TrackerViewTitle } from '../TrackerViewTitle';

function renderTitle(overrides: Partial<Parameters<typeof TrackerViewTitle>[0]> = {}) {
  const onSaveView = vi.fn();
  const onRenameSavedView = vi.fn();
  const onUpdateSavedView = vi.fn();
  render(
    <TrackerViewTitle
      fallbackTitle="All Items"
      onSaveView={onSaveView}
      onRenameSavedView={onRenameSavedView}
      onUpdateSavedView={onUpdateSavedView}
      {...overrides}
    />,
  );
  return { onSaveView, onRenameSavedView, onUpdateSavedView };
}

describe('TrackerViewTitle', () => {
  it('names a new saved view inline in the left title slot', () => {
    const { onSaveView } = renderTitle({ showSaveViewAction: true });

    expect(screen.getByTestId('tracker-view-title').textContent).toBe('All Items');
    fireEvent.click(screen.getByTestId('tracker-saved-view-add'));
    expect(screen.queryByText('All Items')).toBeNull();
    fireEvent.change(screen.getByTestId('tracker-saved-view-name-input'), {
      target: { value: 'Review queue' },
    });
    fireEvent.keyDown(screen.getByTestId('tracker-saved-view-name-input'), {
      key: 'Enter',
    });

    expect(onSaveView).toHaveBeenCalledWith('Review queue');
  });

  it('replaces All Items with the active saved-view name', () => {
    renderTitle({ activeSavedViewName: 'Review queue' });

    expect(screen.getByTestId('tracker-view-title').textContent).toContain('Review queue');
    expect(screen.queryByText('All Items')).toBeNull();
  });

  it('renames an active saved view inline in the same title slot', () => {
    const { onRenameSavedView } = renderTitle({
      activeSavedViewName: 'Review queue',
    });

    fireEvent.click(screen.getByTestId('tracker-view-title'));
    const input = screen.getByTestId('tracker-saved-view-name-input');
    expect((input as HTMLInputElement).value).toBe('Review queue');
    fireEvent.change(input, { target: { value: 'Ready for review' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRenameSavedView).toHaveBeenCalledWith('Ready for review');
  });

  it('offers Save changes next to a dirty saved-view title', () => {
    const { onUpdateSavedView } = renderTitle({
      activeSavedViewName: 'Review queue',
      savedViewDirty: true,
    });

    fireEvent.click(screen.getByTestId('tracker-saved-view-update'));
    expect(onUpdateSavedView).toHaveBeenCalledTimes(1);
  });
});
