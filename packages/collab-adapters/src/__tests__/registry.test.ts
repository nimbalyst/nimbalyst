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
});
