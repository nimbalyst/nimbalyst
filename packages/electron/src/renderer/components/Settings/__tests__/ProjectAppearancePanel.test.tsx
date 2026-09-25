import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectAppearancePanel } from '../panels/ProjectAppearancePanel';
import { projectAppearanceAtom } from '../../../store/atoms/projectAppearance';
const workspacePath = '/projects/FileRocket';
beforeEach(() => { (window as any).electronAPI = { invoke: vi.fn(), on: vi.fn() }; });
afterEach(() => { cleanup(); projectAppearanceAtom.remove(workspacePath); });
function mount(appearance = {}) {
  const store = createStore();
  store.set(projectAppearanceAtom(workspacePath), { snapshot: { revision: 0, appearance } });
  return render(<Provider store={store}><ProjectAppearancePanel workspacePath={workspacePath} /></Provider>);
}
it('previews overrides, saves explicitly to the target project, and resets all overrides', async () => {
  const invoke = vi.fn().mockResolvedValue({ revision: 1, appearance: { initials: 'FR' } });
  window.electronAPI.invoke = invoke;
  const view = mount();
  expect(view.getByTestId('project-appearance-preview').textContent).toBe('FI');
  fireEvent.change(view.getByLabelText('Initials'), { target: { value: 'FR' } });
  expect(view.getByTestId('project-appearance-preview').textContent).toBe('FR');
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(view.getByText('Save changes'));
  await waitFor(() => expect(view.getByRole('status').textContent).toBe('Saved'));
  expect(invoke).toHaveBeenCalledWith('project-appearance:update', workspacePath, { initials: 'FR' });
  invoke.mockResolvedValue({ revision: 2, appearance: {} });
  fireEvent.click(view.getByText('Reset to default'));
  await waitFor(() => expect(view.getByTestId('project-appearance-preview').textContent).toBe('FI'));
  expect(invoke).toHaveBeenLastCalledWith('project-appearance:update', workspacePath, { initials: null, color: null, image: null });
});
it('keeps edits and explains a failed save', async () => {
  window.electronAPI.invoke = vi.fn().mockRejectedValue(new Error('Disk full'));
  const view = mount();
  fireEvent.change(view.getByLabelText('Initials'), { target: { value: 'FR' } });
  fireEvent.click(view.getByText('Save changes'));
  await waitFor(() => expect(view.getByRole('alert').textContent).toContain('Disk full'));
  expect(view.getByTestId('project-appearance-preview').textContent).toBe('FR');
  expect((view.getByText('Save changes') as HTMLButtonElement).disabled).toBe(false);
});
it('falls back to initials when a stored thumbnail cannot load', () => {
  const view = mount({ initials: 'FR', imageUrl: 'nim-asset://local/missing' });
  fireEvent.error(view.getByTestId('project-appearance-preview').querySelector('img')!);
  expect(view.getByTestId('project-appearance-preview').textContent).toBe('FR');
});
