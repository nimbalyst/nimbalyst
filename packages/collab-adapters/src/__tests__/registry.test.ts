import { describe, expect, it, afterEach } from 'vitest';
import {
  clearCollabContentAdapters,
  getCollabContentAdapter,
  registerCollabContentAdapter,
} from '../registry';
import type { CollabContentAdapter } from '../CollabContentAdapter';

const mockupAdapter: CollabContentAdapter = {
  documentType: 'mockup.html',
  fileExtensions: ['.mockup.html'],
  mimeType: 'text/html',
  layoutVersion: 1,
  isEmpty: () => true,
  seedFromFile: () => {},
  applyFromFile: () => {},
  exportToFile: () => '',
  toPlainText: () => '',
};

describe('getCollabContentAdapter', () => {
  afterEach(() => {
    clearCollabContentAdapters();
  });

  it('resolves adapters by their canonical documentType', () => {
    registerCollabContentAdapter(mockupAdapter);

    expect(getCollabContentAdapter('mockup.html')).toBe(mockupAdapter);
  });

  it('falls back to dot-prefixed extension keys', () => {
    registerCollabContentAdapter(mockupAdapter);

    expect(getCollabContentAdapter('.mockup.html')).toBe(mockupAdapter);
  });

  it('restores the previous adapter when an override is unregistered', () => {
    const builtinRegistration = registerCollabContentAdapter(mockupAdapter);
    const extensionAdapter: CollabContentAdapter = {
      ...mockupAdapter,
      mimeType: 'application/x-extension-override',
    };
    const extensionRegistration = registerCollabContentAdapter(extensionAdapter);

    expect(getCollabContentAdapter('mockup.html')).toBe(extensionAdapter);

    extensionRegistration.unregister();

    expect(getCollabContentAdapter('mockup.html')).toBe(mockupAdapter);
    builtinRegistration.unregister();
    expect(getCollabContentAdapter('mockup.html')).toBeUndefined();
  });
});
