import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import { openSettingsCommandAtom } from '../../store/atoms/settingsNavigation';
import { projectAppearanceAtom } from '../../store/atoms/projectAppearance';
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

it('customizes an inactive project without switching or editing the active project', () => {
  const store = createStore();
  const projects = [{ path: '/p/active', name: 'Active', openedAt: 0 }, { path: '/p/FileRocket', name: 'FileRocket', openedAt: 1 }];
  store.set(multiProjectModeAtom, true);
  store.set(openProjectsAtom, projects);
  store.set(activeWorkspacePathAtom, projects[0].path);
  for (const project of projects) store.set(projectAppearanceAtom(project.path), { snapshot: { revision: 0, appearance: {} } });
  const view = render(<Provider store={store}><ProjectRail /></Provider>);
  fireEvent.contextMenu(view.getByRole('button', { name: 'Switch to project FileRocket' }));
  fireEvent.click(view.getByText('Customize appearance…'));
  expect(store.get(openSettingsCommandAtom)?.destination).toEqual({ scope: 'project', category: 'project-appearance', target: { kind: 'workspace', workspacePath: projects[1].path } });
  expect(store.get(activeWorkspacePathAtom)).toBe(projects[0].path);
});
