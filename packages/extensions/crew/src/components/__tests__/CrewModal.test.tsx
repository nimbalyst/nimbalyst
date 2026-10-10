import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrewModal } from '../CrewBits';

vi.mock('@nimbalyst/extension-sdk', () => ({
  MaterialSymbol: () => null,
  navigateToTrackerReference: vi.fn(),
}));

afterEach(cleanup);

describe('CrewModal', () => {
  it('keeps focus in a field when the parent re-renders with a new onClose', () => {
    // The roster poll re-renders the panel every few seconds, passing a fresh
    // onClose arrow each time. That must not pull focus back to the dialog.
    const modal = (onClose: () => void) => (
      <CrewModal title="Hire" onClose={onClose}>
        <textarea data-testid="field" />
      </CrewModal>
    );
    const { getByTestId, rerender } = render(modal(() => {}));
    const field = getByTestId('field');
    field.focus();

    rerender(modal(() => {}));

    expect(document.activeElement).toBe(field);
  });
});
