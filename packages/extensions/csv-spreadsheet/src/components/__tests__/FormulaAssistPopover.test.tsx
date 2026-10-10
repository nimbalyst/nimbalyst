import { createRef, useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getFormulaAutocomplete } from '../../formula/formulaAssist';
import { FormulaAssistPopover } from '../FormulaAssistPopover';
import { FormulaBar, type FormulaBarHandle } from '../FormulaBar';

function Harness({ onAccept, onDismiss, onEditorKey }: {
  onAccept: (name: string) => void;
  onDismiss: () => void;
  onEditorKey: (key: string) => void;
}) {
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  return (
    <>
      <input ref={setInput} defaultValue="=COU" onKeyDown={(event) => onEditorKey(event.key)} />
      <FormulaAssistPopover
        anchor={input}
        autocomplete={getFormulaAutocomplete('=COU', 4)}
        signatureHelp={null}
        onAccept={(entry) => onAccept(entry.name)}
        onDismiss={onDismiss}
      />
    </>
  );
}

describe('FormulaAssistPopover keyboard', () => {
  it('moves with arrows, accepts with Enter or Tab, dismisses with Escape, and keeps those keys from the editor', () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    const onEditorKey = vi.fn();
    const { getByRole } = render(<Harness onAccept={onAccept} onDismiss={onDismiss} onEditorKey={onEditorKey} />);
    const input = getByRole('textbox');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAccept).toHaveBeenLastCalledWith('COUNTA');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onAccept).toHaveBeenLastCalledWith('COUNT');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: 'a' });
    expect(onEditorKey.mock.calls.map(([key]) => key)).toEqual(['a']);
  });
});

describe('FormulaBar formula editing', () => {
  it('accepts autocomplete with Tab, cycles a reference with F4, and commits the result on Enter', async () => {
    const onChange = vi.fn();
    const bar = createRef<FormulaBarHandle>();
    const { getByLabelText, getAllByRole, findByRole } = render(<FormulaBar ref={bar} onChange={onChange} />);
    act(() => bar.current!.update('A1', '', false));
    const input = getAllByRole('textbox').find((element) => element !== getByLabelText('Name box')) as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: '=SU' } });
    await findByRole('listbox');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('=SUM(');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.input(input, { target: { value: '=SUM(A1' } });
    fireEvent.keyDown(input, { key: 'F4' });
    expect(input.value).toBe('=SUM($A$1');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('=SUM($A$1');
  });

  it('jumps to a reference typed into the name box and refuses one that is not a reference', () => {
    const onNavigate = vi.fn();
    const bar = createRef<FormulaBarHandle>();
    const { getByLabelText } = render(<FormulaBar ref={bar} onChange={vi.fn()} onNavigate={onNavigate} />);
    act(() => bar.current!.update('A1', '', false));
    const nameBox = getByLabelText('Name box') as HTMLInputElement;

    fireEvent.focus(nameBox);
    fireEvent.change(nameBox, { target: { value: 'nope' } });
    fireEvent.keyDown(nameBox, { key: 'Enter' });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(nameBox.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(nameBox, { target: { value: 'b2:c4' } });
    fireEvent.keyDown(nameBox, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith({ startRow: 1, endRow: 3, startCol: 1, endCol: 2 });
  });
});
