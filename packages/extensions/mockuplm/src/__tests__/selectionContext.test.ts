import { describe, expect, it } from 'vitest';
import {
  buildConnectionSelectionContextItem,
  buildMockupSelectionContextItem,
} from '../selectionContext';
import type { Connection, MockupReference } from '../types/project';

const screen = (id: string, label: string): MockupReference => ({
  id,
  label,
  path: `${label.toLowerCase().replace(/\s+/g, '-')}.mockup.html`,
  position: { x: 0, y: 0 },
  size: { width: 400, height: 300 },
});

describe('MockupLM selection context', () => {
  const login = screen('login', 'Login');
  const home = screen('home', 'Home');
  const settings = screen('settings', 'Settings');
  const connections: Connection[] = [
    { id: 'c1', fromMockupId: 'login', toMockupId: 'home', label: 'Sign in', trigger: 'click' },
    { id: 'c2', fromMockupId: 'home', toMockupId: 'login', label: 'Log out' },
  ];
  const ctx = { projectName: 'My App', mockups: [login, home, settings], connections };

  it('reports the selected screen with flows, stable identity, and bounded opt-in data', () => {
    const item = buildMockupSelectionContextItem(login, ctx);

    expect(item.id).toBe('mockup:login');
    expect(item.groupLabel).toBe('screens');
    expect(item.includeData).toBe(true);
    expect(item.description).toContain('Selected screen "Login"');
    // Outbound and inbound flows resolve to sibling screen labels.
    expect(item.description).toContain('Navigates to: Home (Sign in)');
    expect(item.description).toContain('Navigated from: Home (Log out)');
    expect(item.description).toContain('All screens (3)');
    expect(JSON.stringify(item.data).length).toBeLessThan(32 * 1024);
  });

  it('refreshes the description when the selected screen mutates but keeps its id', () => {
    const before = buildMockupSelectionContextItem(login, ctx);
    const after = buildMockupSelectionContextItem({ ...login, label: 'Sign In' }, ctx);

    expect(after.id).toBe(before.id);
    expect(after.description).toContain('Selected screen "Sign In"');
  });

  it('describes a selected navigation flow by its endpoint screens and trigger', () => {
    const item = buildConnectionSelectionContextItem(connections[0], {
      projectName: ctx.projectName,
      mockups: ctx.mockups,
    });

    expect(item.id).toBe('connection:c1');
    expect(item.groupLabel).toBe('flows');
    expect(item.label).toBe('Login → Home');
    expect(item.description).toContain('from screen "Login" to "Home"');
    expect(item.description).toContain('Trigger: click');
  });
});
