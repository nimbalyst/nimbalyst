import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSpreadsheetData } from '../useSpreadsheetData';

describe('useSpreadsheetData history', () => {
  it('supports consecutive undo and redo after three edits', () => {
    const { result } = renderHook(() =>
      useSpreadsheetData('Name,Value\nAlpha,1\n', '/tmp/history.csv')
    );

    act(() => result.current.updateCell(1, 0, 'First'));
    act(() => result.current.updateCell(1, 0, 'Second'));
    act(() => result.current.updateCell(1, 0, 'Third'));

    expect(result.current.data.rows[1][0].raw).toBe('Third');

    act(() => result.current.undo());
    expect(result.current.data.rows[1][0].raw).toBe('Second');

    act(() => result.current.undo());
    expect(result.current.data.rows[1][0].raw).toBe('First');

    act(() => result.current.redo());
    expect(result.current.data.rows[1][0].raw).toBe('Second');
  });
});
