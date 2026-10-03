import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectRail } from '../ProjectRail';
import { activeWorkspacePathAtom, multiProjectModeAtom, openProjectsAtom } from '../../store/atoms/openProjects';

vi.mock('@nimbalyst/runtime', () => ({ getShowInFileBrowserLabel: () => 'Show in Finder' }));
vi.mock('../OrgSwitcher', () => ({ OrgSwitcher: () => null }));
vi.mock('../WorkspaceSummaryHeader', () => ({ generateWorkspaceAccentColor: () => '#123456' }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reveals restored and newly selected projects, handles resize, and leaves manual scrolling alone', () => {
  const store = createStore();
  const projects = Array.from({ length: 32 }, (_, i) => ({ path: `/p/${i}`, name: `Project ${i}`, openedAt: i }));
  store.set(multiProjectModeAtom, true);
  store.set(openProjectsAtom, projects);
  store.set(activeWorkspacePathAtom, projects[31].path);
  let height = 400;
  let resized = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    if (this.classList.contains('project-rail-projects')) return { top: 100, bottom: 100 + height } as DOMRect;
    if (this.classList.contains('project-rail-item')) {
      const index = Number(this.dataset.projectPath!.split('/').pop());
      const list = this.closest('.project-rail-projects')!;
      const top = 104 + index * 48 - list.scrollTop;
      return { top, bottom: top + 40 } as DOMRect;
    }
    return { top: 0, bottom: 0 } as DOMRect;
  });
  const tree = <Provider store={store}><ProjectRail /></Provider>;
  const view = render(tree);
  const list = view.getByTestId('project-rail-projects');
  const visible = (index: number) => {
    const item = view.getByRole('button', { name: `Switch to project Project ${index}` }).parentElement!;
    expect(item.getBoundingClientRect().top).toBeGreaterThanOrEqual(100);
    expect(item.getBoundingClientRect().bottom).toBeLessThanOrEqual(100 + height);
  };
  visible(31);
  act(() => store.set(activeWorkspacePathAtom, projects[0].path));
  visible(0);
  act(() => store.set(activeWorkspacePathAtom, projects[31].path));
  visible(31);
  act(() => { height = 200; resized(); });
  visible(31);
  list.scrollTop = 0; // Browsing other projects must not snap back to the selection.
  view.rerender(<Provider store={store}><ProjectRail /></Provider>);
  expect(list.scrollTop).toBe(0);
  view.unmount();
  expect(disconnect).toHaveBeenCalled();
});


it('moves and sorts from the keyboard menu without activating the targeted project', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const store = createStore();
  const projects = ['Zebra', 'Alpha', 'Beta'].map(name => ({ path: `/p/${name}`, name, openedAt: 0 }));
  store.set(multiProjectModeAtom, true);
  store.set(openProjectsAtom, projects);
  store.set(activeWorkspacePathAtom, projects[0].path);
  const view = render(<Provider store={store}><ProjectRail /></Provider>);
  const alpha = view.getByRole('button', { name: 'Switch to project Alpha' });
  alpha.focus();
  fireEvent.keyDown(alpha, { key: 'F10', shiftKey: true });
  const up = await view.findByRole('menuitem', { name: 'Move up' });
  await waitFor(() => expect(document.activeElement).toBe(up));
  fireEvent.click(up);
  expect(store.get(openProjectsAtom).map(p => p.name)).toEqual(['Alpha', 'Zebra', 'Beta']);
  expect(store.get(activeWorkspacePathAtom)).toBe(projects[0].path);
  await waitFor(() => expect(document.activeElement).toBe(alpha));
  fireEvent.keyDown(alpha, { key: 'ContextMenu' });
  expect((await view.findByRole('menuitem', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(view.getByRole('menuitem', { name: 'Move down' }));
  expect(store.get(openProjectsAtom).map(p => p.name)).toEqual(['Zebra', 'Alpha', 'Beta']);
  fireEvent.contextMenu(alpha, { clientX: 40, clientY: 100 });
  const down = await view.findByRole('menuitem', { name: 'Move down' });
  down.focus();
  fireEvent.keyDown(down, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(view.getByRole('menuitem', { name: 'Sort by name' }));
  fireEvent.click(view.getByRole('menuitem', { name: 'Sort by name' }));
  expect(store.get(openProjectsAtom).map(p => p.name)).toEqual(['Alpha', 'Beta', 'Zebra']);
  expect(store.get(activeWorkspacePathAtom)).toBe(projects[0].path);
});

it('commits a native drag only on drop, and ignores external drops and cancellation', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const store = createStore();
  const projects = ['A', 'B', 'C'].map(name => ({ path: `/p/${name}`, name, openedAt: 0 }));
  store.set(multiProjectModeAtom, true);
  store.set(openProjectsAtom, projects);
  store.set(activeWorkspacePathAtom, projects[0].path);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const index = projects.findIndex(p => p.path === this.dataset.projectPath);
    return { top: index * 48, bottom: index * 48 + 40, height: 40, left: 0, right: 56 } as DOMRect;
  });
  const view = render(<Provider store={store}><ProjectRail /></Provider>);
  const list = view.getByTestId('project-rail-projects');
  const source = view.getByRole('button', { name: 'Switch to project C' });
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
  fireEvent(list, Object.assign(new MouseEvent('drop', { bubbles: true, clientY: 0 }), { dataTransfer }));
  expect(store.get(openProjectsAtom)).toBe(projects);
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.dragOver(list, { clientY: 0, dataTransfer });
  expect(store.get(openProjectsAtom)).toBe(projects);
  fireEvent.dragEnd(source);
  expect(store.get(openProjectsAtom)).toBe(projects);
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent(list, Object.assign(new MouseEvent('drop', { bubbles: true, clientY: 0 }), { dataTransfer }));
  expect(store.get(openProjectsAtom).map(p => p.name)).toEqual(['C', 'A', 'B']);
  expect(store.get(activeWorkspacePathAtom)).toBe(projects[0].path);
});
