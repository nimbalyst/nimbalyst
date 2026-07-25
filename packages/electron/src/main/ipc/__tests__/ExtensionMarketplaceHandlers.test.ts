import { describe, expect, it } from 'vitest';
import { isManifestOnlyExtension } from '../ExtensionMarketplaceHandlers';

describe('isManifestOnlyExtension', () => {
  it('returns true for a themes-only manifest with no main field', () => {
    const manifest = {
      id: 'com.example.mytheme',
      name: 'My Theme',
      version: '1.0.0',
      contributions: {
        themes: [{ id: 'my-theme', name: 'My Theme', isDark: true, colors: {} }],
      },
    };
    expect(isManifestOnlyExtension(manifest)).toBe(true);
  });

  it('returns true for a claudePlugin-only manifest with no main field', () => {
    const manifest = {
      id: 'com.example.myplugin',
      version: '1.0.0',
      contributions: {
        claudePlugin: { systemPrompt: 'You are helpful.' },
      },
    };
    expect(isManifestOnlyExtension(manifest)).toBe(true);
  });

  it('returns false when manifest has a main field even if only themes are declared', () => {
    const manifest = {
      id: 'com.example.mytheme',
      version: '1.0.0',
      main: 'dist/index.js',
      contributions: {
        themes: [{ id: 'my-theme', name: 'My Theme', isDark: true, colors: {} }],
      },
    };
    expect(isManifestOnlyExtension(manifest)).toBe(false);
  });

  it('returns false when contributions includes aiTools alongside themes', () => {
    const manifest = {
      id: 'com.example.mixed',
      version: '1.0.0',
      contributions: {
        themes: [{ id: 'my-theme', name: 'My Theme', isDark: true, colors: {} }],
        aiTools: [{ name: 'myTool' }],
      },
    };
    expect(isManifestOnlyExtension(manifest)).toBe(false);
  });

  it('returns false when contributions includes customEditors', () => {
    const manifest = {
      id: 'com.example.editor',
      version: '1.0.0',
      main: 'dist/index.js',
      contributions: {
        customEditors: [{ viewType: 'myEditor', displayName: 'My Editor', selector: [{ filenamePattern: '*.foo' }] }],
      },
    };
    expect(isManifestOnlyExtension(manifest)).toBe(false);
  });

  it('returns false when contributions is absent', () => {
    const manifest = { id: 'com.example.empty', version: '1.0.0' };
    expect(isManifestOnlyExtension(manifest)).toBe(false);
  });

  it('returns false when both themes and claudePlugin are declared', () => {
    // Neither onlyThemes nor onlyClaudePlugin is satisfied when both are present
    const manifest = {
      id: 'com.example.combo',
      version: '1.0.0',
      contributions: {
        themes: [{ id: 'my-theme', name: 'My Theme', isDark: true, colors: {} }],
        claudePlugin: { systemPrompt: 'helper' },
      },
    };
    expect(isManifestOnlyExtension(manifest)).toBe(false);
  });

  it('matches the shape of the canonical example-theme manifest', () => {
    // Mirrors packages/extensions/example-theme/manifest.json
    const manifest = {
      id: 'com.nimbalyst.example-theme',
      name: 'Example Theme',
      version: '1.0.0',
      apiVersion: '1.0',
      contributions: {
        themes: [
          {
            id: 'midnight-orchid',
            name: 'Midnight Orchid',
            isDark: true,
            colors: { bg: '#1a0f24' },
          },
        ],
      },
    };
    expect(isManifestOnlyExtension(manifest)).toBe(true);
  });
});
