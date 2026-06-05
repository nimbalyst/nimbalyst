import { describe, expect, it } from 'vitest';
import { getMonacoTheme, toMonacoExtensionThemeName } from '../monacoUtils';
import { registerThemeContribution } from '../../editor/themes/registry';

describe('getMonacoTheme', () => {
  it('maps built-in monokai theme ID to monaco monokai theme', () => {
    expect(getMonacoTheme('light', undefined, 'monokai')).toBe('monokai');
  });

  it('maps built-in solarized theme IDs to custom monaco themes', () => {
    expect(getMonacoTheme('light', undefined, 'solarized-light')).toBe('solarized-light');
    expect(getMonacoTheme('dark', undefined, 'solarized-dark')).toBe('solarized-dark');
  });

  it('preserves support for legacy namespaced theme IDs', () => {
    expect(getMonacoTheme('light', undefined, 'sample-themes:monokai')).toBe('monokai');
  });

  it('maps crystal-dark to Monaco dark theme', () => {
    expect(getMonacoTheme('crystal-dark')).toBe('vs-dark');
  });

  it('returns the sanitized Monaco theme name when the registry has a monaco block', () => {
    const unregister = registerThemeContribution('test.ext.mono', {
      id: 'dracula',
      name: 'Dracula',
      isDark: true,
      colors: {},
      monaco: {
        base: 'vs-dark',
        rules: [{ token: 'comment', foreground: '6272a4', fontStyle: 'italic' }],
        colors: { 'editor.background': '#282a36' },
      },
    });
    try {
      // Monaco rejects names with `.` or `:`, so we sanitize the
      // namespaced extension id when handing it to Monaco.
      const expected = toMonacoExtensionThemeName('test.ext.mono:dracula');
      expect(getMonacoTheme('dark', true, 'test.ext.mono:dracula')).toBe(expected);
      expect(expected).toMatch(/^[a-z0-9-]+$/);
    } finally {
      unregister();
    }
  });

  it('falls back to base Monaco theme when extension has no monaco block', () => {
    const unregister = registerThemeContribution('test.ext.plain', {
      id: 'plain',
      name: 'Plain',
      isDark: true,
      colors: {},
    });
    try {
      expect(getMonacoTheme('dark', true, 'test.ext.plain:plain')).toBe('vs-dark');
      expect(getMonacoTheme('light', false, 'test.ext.plain:plain')).toBe('vs');
    } finally {
      unregister();
    }
  });

  it('falls back to base Monaco theme after the extension theme is unregistered', () => {
    const unregister = registerThemeContribution('test.ext.gone', {
      id: 'fleeting',
      name: 'Fleeting',
      isDark: true,
      colors: {},
      monaco: {
        base: 'vs-dark',
        rules: [],
        colors: { 'editor.background': '#000000' },
      },
    });
    expect(getMonacoTheme('dark', true, 'test.ext.gone:fleeting')).toBe(
      toMonacoExtensionThemeName('test.ext.gone:fleeting')
    );

    unregister();

    // After unregistration, the extension id no longer resolves to a
    // registered theme and we fall back to the base Monaco theme.
    expect(getMonacoTheme('dark', true, 'test.ext.gone:fleeting')).toBe('vs-dark');
  });

  it('strips the namespace prefix when computing the Monaco theme name', () => {
    expect(toMonacoExtensionThemeName('com.acme.themes:rose-pine')).toBe('rose-pine');
    expect(toMonacoExtensionThemeName('com.rosepinetheme.nimbalyst:rose-pine-moon')).toBe('rose-pine-moon');
    // No namespace -> returned verbatim.
    expect(toMonacoExtensionThemeName('monokai')).toBe('monokai');
  });
});
