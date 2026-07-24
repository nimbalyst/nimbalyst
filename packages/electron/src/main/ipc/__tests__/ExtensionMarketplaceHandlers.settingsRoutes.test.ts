import { describe, expect, it } from 'vitest';
import { isManifestOnlyExtension } from '../ExtensionMarketplaceHandlers';

describe('isManifestOnlyExtension settings routes', () => {
  it('requires a runtime bundle for a contributed settings route', () => {
    expect(isManifestOnlyExtension({
      id: 'com.example.settings',
      version: '1.0.0',
      contributions: {
        themes: [{ id: 'my-theme', name: 'My Theme', isDark: true, colors: {} }],
        settingsRoutes: [
          {
            id: 'connections',
            scope: 'project',
            label: 'Connections',
            component: 'ConnectionSettings',
          },
        ],
      },
    })).toBe(false);
  });
});
