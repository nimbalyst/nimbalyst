import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerThemeContribution,
  getAllThemes,
  getExtensionThemes,
  getTheme,
  hasTheme,
  onThemesChanged,
  getThemesWithMonacoDefinition,
} from '../registry';

describe('theme registry: extension contributions', () => {
  // The registry is a module-level singleton; clean up our test themes before
  // each test so registrations don't leak across cases.
  const TEST_EXT = 'test.example.themes';
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn?.(); } catch { /* ignore */ }
    }
  });

  it('registers a contribution under a namespaced ID', () => {
    const unregister = registerThemeContribution(TEST_EXT, {
      id: 'dracula',
      name: 'Dracula',
      isDark: true,
      colors: { 'bg': '#282a36', 'text': '#f8f8f2' },
    });
    cleanups.push(unregister);

    const theme = getTheme(`${TEST_EXT}:dracula`);
    expect(theme).toBeDefined();
    expect(theme?.name).toBe('Dracula');
    expect(theme?.isDark).toBe(true);
    expect(theme?.contributedBy).toBe(TEST_EXT);
    // Color overrides land on top of base colors
    expect(theme?.colors.bg).toBe('#282a36');
    expect(theme?.colors.text).toBe('#f8f8f2');
  });

  it('unregistering removes the theme from getAllThemes/getExtensionThemes', () => {
    const fullId = `${TEST_EXT}:my-theme`;
    const unregister = registerThemeContribution(TEST_EXT, {
      id: 'my-theme',
      name: 'My Theme',
      isDark: false,
      colors: {},
    });

    expect(hasTheme(fullId)).toBe(true);
    expect(getExtensionThemes().some(t => t.id === fullId)).toBe(true);

    unregister();

    expect(hasTheme(fullId)).toBe(false);
    expect(getExtensionThemes().some(t => t.id === fullId)).toBe(false);
    expect(getAllThemes().some(t => t.id === fullId)).toBe(false);
  });

  it('notifies onThemesChanged listeners on register and unregister', () => {
    const calls: number[] = [];
    const offListener = onThemesChanged((themes) => {
      calls.push(themes.length);
    });
    cleanups.push(() => offListener());

    const unregister = registerThemeContribution(TEST_EXT, {
      id: 'event-test',
      name: 'Event Test',
      isDark: true,
      colors: {},
    });
    expect(calls.length).toBe(1);

    unregister();
    expect(calls.length).toBe(2);
  });

  it('two extensions can use the same contribution id without colliding', () => {
    const u1 = registerThemeContribution('ext.one', {
      id: 'shared',
      name: 'Shared One',
      isDark: false,
      colors: { primary: '#ff0000' },
    });
    cleanups.push(u1);
    const u2 = registerThemeContribution('ext.two', {
      id: 'shared',
      name: 'Shared Two',
      isDark: true,
      colors: { primary: '#00ff00' },
    });
    cleanups.push(u2);

    const a = getTheme('ext.one:shared');
    const b = getTheme('ext.two:shared');
    expect(a?.name).toBe('Shared One');
    expect(b?.name).toBe('Shared Two');
    expect(a?.colors.primary).toBe('#ff0000');
    expect(b?.colors.primary).toBe('#00ff00');
  });

  it('carries Monaco theme definition through registration', () => {
    const unregister = registerThemeContribution(TEST_EXT, {
      id: 'mono-test',
      name: 'Mono Test',
      isDark: true,
      colors: { bg: '#101020' },
      monaco: {
        base: 'vs-dark',
        rules: [
          { token: 'comment', foreground: '808080', fontStyle: 'italic' },
          { token: 'keyword', foreground: 'ff79c6' },
        ],
        colors: {
          'editor.background': '#101020',
          'editor.foreground': '#eeeeee',
        },
      },
    });
    cleanups.push(unregister);

    const theme = getTheme(`${TEST_EXT}:mono-test`);
    expect(theme?.monaco).toBeDefined();
    expect(theme?.monaco?.base).toBe('vs-dark');
    expect(theme?.monaco?.rules).toHaveLength(2);
    expect(theme?.monaco?.colors['editor.background']).toBe('#101020');

    const withMonaco = getThemesWithMonacoDefinition();
    expect(withMonaco.some(t => t.id === `${TEST_EXT}:mono-test`)).toBe(true);
  });

  it('omits themes without a Monaco block from getThemesWithMonacoDefinition', () => {
    const unregister = registerThemeContribution(TEST_EXT, {
      id: 'no-monaco',
      name: 'No Monaco',
      isDark: false,
      colors: { bg: '#ffffff' },
    });
    cleanups.push(unregister);

    const withMonaco = getThemesWithMonacoDefinition();
    expect(withMonaco.some(t => t.id === `${TEST_EXT}:no-monaco`)).toBe(false);
  });

  it('derives table/code colors from extension overrides when not provided', () => {
    const unregister = registerThemeContribution(TEST_EXT, {
      id: 'derive',
      name: 'Derive Test',
      isDark: true,
      colors: {
        bg: '#101020',
        'bg-secondary': '#202040',
        'bg-tertiary': '#303060',
        border: '#444466',
        text: '#eeeeee',
      },
    });
    cleanups.push(unregister);

    const theme = getTheme(`${TEST_EXT}:derive`);
    expect(theme).toBeDefined();
    // Derived colors should pick up the extension's overrides
    expect(theme?.colors['table-header']).toBe('#202040');
    expect(theme?.colors['table-cell']).toBe('#101020');
    expect(theme?.colors['table-stripe']).toBe('#303060');
    expect(theme?.colors['code-bg']).toBe('#202040');
    expect(theme?.colors['code-text']).toBe('#eeeeee');
  });
});
