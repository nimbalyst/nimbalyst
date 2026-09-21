import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CanvasScreenTitle } from '../CanvasScreenTitle';

afterEach(cleanup);

it('commits a trimmed title once on Enter and contains editing keys', () => {
  const rename = vi.fn(),
    outerKey = vi.fn(),
    outerDoubleClick = vi.fn();
  render(
    <div onKeyDown={outerKey} onDoubleClick={outerDoubleClick}>
      <CanvasScreenTitle label="Files" readOnly={false} onRename={rename} />
    </div>
  );
  fireEvent.doubleClick(screen.getByRole('button', { name: 'Rename Files' }));
  const input = screen.getByRole('textbox', { name: 'Screenshot title' });
  fireEvent.change(input, { target: { value: '  Workspace  ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.blur(input);
  expect(rename.mock.calls).toEqual([['Workspace']]);
  expect(outerKey).not.toHaveBeenCalled();
  expect(outerDoubleClick).not.toHaveBeenCalled();
});

it('cancels on Escape, ignores empty titles, and saves on blur', () => {
  const rename = vi.fn();
  render(
    <CanvasScreenTitle label="Files" readOnly={false} onRename={rename} />
  );
  const start = () => {
    fireEvent.doubleClick(screen.getByRole('button'));
    return screen.getByRole('textbox');
  };
  let input = start();
  fireEvent.change(input, { target: { value: 'Discard me' } });
  fireEvent.keyDown(input, { key: 'Escape' });
  input = start();
  expect((input as HTMLInputElement).value).toBe('Files');
  fireEvent.change(input, { target: { value: '   ' } });
  fireEvent.blur(input);
  expect(rename).not.toHaveBeenCalled();
  input = start();
  fireEvent.change(input, { target: { value: 'Workspace' } });
  fireEvent.blur(input);
  expect(rename.mock.calls).toEqual([['Workspace']]);
});

it('supports keyboard editing and cancels when the card becomes read-only', () => {
  const rename = vi.fn();
  const { rerender } = render(
    <CanvasScreenTitle label="Files" readOnly={false} onRename={rename} />
  );
  fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Not allowed' },
  });
  rerender(<CanvasScreenTitle label="Files" readOnly onRename={rename} />);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(rename).not.toHaveBeenCalled();
});
