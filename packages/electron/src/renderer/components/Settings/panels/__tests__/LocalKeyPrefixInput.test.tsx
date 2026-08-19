// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LocalKeyPrefixInput, type LocalKeyPrefixConfig } from '../LocalKeyPrefixInput';

afterEach(cleanup);

function config(overrides: Partial<LocalKeyPrefixConfig> = {}): LocalKeyPrefixConfig {
  return {
    prefix: 'LOC',
    hasIssuedNumbers: false,
    matchesTeamPrefix: false,
    ...overrides,
  };
}

describe('LocalKeyPrefixInput', () => {
  it('normalizes and saves an editable prefix', async () => {
    const onChange = vi.fn(async (prefix: string) => config({ prefix }));
    render(<LocalKeyPrefixInput config={config()} teamPrefix="NIM" onChange={onChange} />);

    const input = screen.getByLabelText('Local tracker number prefix');
    fireEvent.change(input, { target: { value: 'dev' } });
    fireEvent.blur(input);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('DEV'));
    expect((input as HTMLInputElement).value).toBe('DEV');
  });

  it('shows a matching-team warning without disabling the choice', () => {
    render(
      <LocalKeyPrefixInput
        config={config({ matchesTeamPrefix: true, warning: 'Choose different letters if you want stronger visual separation.' })}
        teamPrefix="LOC"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Choose different letters if you want stronger visual separation.')).toBeTruthy();
    expect((screen.getByLabelText('Local tracker number prefix') as HTMLInputElement).disabled).toBe(false);
  });

  /**
   * Numbers already issued are renamed, not reissued, so the change is allowed
   * -- but a reference someone wrote down under the old letters stops
   * resolving, which is worth a confirmation.
   */
  it('confirms before renaming numbers that have already been issued', async () => {
    const onChange = vi.fn(async (prefix: string) => config({ prefix, hasIssuedNumbers: true }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <LocalKeyPrefixInput config={config({ hasIssuedNumbers: true })} teamPrefix="NIM" onChange={onChange} />,
    );

    const input = screen.getByLabelText('Local tracker number prefix');
    expect((input as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'NIC' } });
    fireEvent.blur(input);

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('LOC. to NIC.'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('NIC'));
    confirm.mockRestore();
  });

  it('leaves the prefix alone when the confirmation is declined', () => {
    const onChange = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <LocalKeyPrefixInput config={config({ hasIssuedNumbers: true })} teamPrefix="NIM" onChange={onChange} />,
    );

    const input = screen.getByLabelText('Local tracker number prefix');
    fireEvent.change(input, { target: { value: 'NIC' } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('LOC');
    confirm.mockRestore();
  });

  it('does not confirm when no number has been issued yet', async () => {
    const onChange = vi.fn(async (prefix: string) => config({ prefix }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LocalKeyPrefixInput config={config()} teamPrefix="NIM" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Local tracker number prefix'), { target: { value: 'NIC' } });
    fireEvent.blur(screen.getByLabelText('Local tracker number prefix'));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('NIC'));
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('keeps invalid prefixes local instead of invoking the settings API', () => {
    const onChange = vi.fn();
    render(<LocalKeyPrefixInput config={config()} teamPrefix="NIM" onChange={onChange} />);

    const input = screen.getByLabelText('Local tracker number prefix');
    fireEvent.change(input, { target: { value: 'X' } });
    fireEvent.blur(input);

    expect(screen.getByText('Must be 2-5 uppercase letters')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });
});
