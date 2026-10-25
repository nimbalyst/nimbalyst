// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'jotai';
import { store } from '@nimbalyst/runtime/store/store';
import { GeminiPanel } from '../GeminiPanel';
import { hydrateSettingsAtoms } from '../../../../store/atoms/settingAtomFamily';

const provider = 'antigravity-gemini-agent';
const low = `${provider}:gemini-3.5-flash-lite`;
const medium = `${provider}:gemini-3.8-flash-tiered`;
const high = `${provider}:gemini-3.1-pro-high`;
const catalog = [
  { id: low, name: 'Gemini 3.5 Flash Lite', provider },
  { id: medium, name: 'Gemini 3.8 Flash (Tiered)', provider },
  { id: high, name: 'Gemini 3.1 Pro (High)', provider },
  { id: `${provider}:argon-4`, name: 'Argon 4', provider },
];

function mount() {
  return render(<Provider store={store}><GeminiPanel config={{ enabled: true }} onToggle={() => {}} /></Provider>);
}

describe('Gemini persistent model choices', () => {
  beforeEach(() => {
    hydrateSettingsAtoms({ 'ai.gemini.lowModel': '', 'ai.gemini.mediumModel': '', 'ai.gemini.highModel': '' } as any);
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      aiGetHeadlessAgentAvailability: async () => ({ [provider]: { installed: true } }),
      invoke: vi.fn(async () => ({ success: true, models: catalog })),
    } });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('only discovers explicitly, keeps the three selections independent, and restores them on remount', async () => {
    const view = mount();
    const lowSelect = await screen.findByRole('combobox', { name: 'Low' });
    expect(window.electronAPI.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discover models' }));
    await waitFor(() => expect(within(lowSelect).getAllByRole('option').map(o => (o as HTMLOptionElement).value)).toContain(low));
    const mediumSelect = screen.getByRole('combobox', { name: 'Medium' });
    const highSelect = screen.getByRole('combobox', { name: 'High' });
    expect(within(lowSelect).queryByRole('option', { name: 'Argon 4' })).toBeNull();
    expect(within(mediumSelect).queryByRole('option', { name: 'Gemini 3.1 Pro (High)' })).toBeNull();
    fireEvent.change(lowSelect, { target: { value: low } });
    fireEvent.change(mediumSelect, { target: { value: medium } });
    fireEvent.change(highSelect, { target: { value: high } });
    await waitFor(() => expect((highSelect as HTMLSelectElement).value).toBe(high));
    view.unmount();
    mount();
    await screen.findByText('Installed');
    expect((screen.getByRole('combobox', { name: 'Low' }) as HTMLSelectElement).value).toBe(low);
    expect((screen.getByRole('combobox', { name: 'Medium' }) as HTMLSelectElement).value).toBe(medium);
    expect((screen.getByRole('combobox', { name: 'High' }) as HTMLSelectElement).value).toBe(high);
  });

  it('retains a saved unavailable model after empty discovery without selecting another model', async () => {
    hydrateSettingsAtoms({ 'ai.gemini.lowModel': low, 'ai.gemini.mediumModel': medium, 'ai.gemini.highModel': high } as any);
    (window.electronAPI.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, models: [] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Discover models' }));
    await screen.findByText(/No usable Gemini models/);
    expect((screen.getByRole('combobox', { name: 'Medium' }) as HTMLSelectElement).value).toBe(medium);
    expect(screen.getAllByText(/Unavailable.*selection kept/i).length).toBe(3);
  });

  it('shows save failures and leaves the previously persisted selection visible', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    hydrateSettingsAtoms({ 'ai.gemini.mediumModel': medium } as any);
    (window as any).electronAPI.settingsSet = async () => { throw new Error('Disk write failed'); };
    mount();
    const select = await screen.findByRole('combobox', { name: 'Medium' });
    await act(async () => { fireEvent.change(select, { target: { value: '' } }); });
    expect((await screen.findByRole('alert')).textContent).toContain('Disk write failed');
    expect((select as HTMLSelectElement).value).toBe(medium);
  });
});
