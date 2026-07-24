import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClearWorkspaceSchemas, mockRegister, mockLoadBuiltinTrackers } = vi.hoisted(() => ({
  mockClearWorkspaceSchemas: vi.fn(),
  mockRegister: vi.fn(),
  mockLoadBuiltinTrackers: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  globalRegistry: {
    clearWorkspaceSchemas: mockClearWorkspaceSchemas,
    register: mockRegister,
  },
  loadBuiltinTrackers: mockLoadBuiltinTrackers,
}));

import { applySchemasToRegistry } from '../trackerSchemaRegistryUtils';

describe('applySchemasToRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears workspace schemas before applying the full schema list', () => {
    const schemas = [
      { type: 'bug' },
      { type: 'github-pr' },
    ];

    applySchemasToRegistry(schemas);

    expect(mockClearWorkspaceSchemas).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenNthCalledWith(1, schemas[0]);
    expect(mockRegister).toHaveBeenNthCalledWith(2, schemas[1]);
    expect(mockLoadBuiltinTrackers).not.toHaveBeenCalled();
  });

  it('falls back to builtins when the main process returns no schemas', () => {
    applySchemasToRegistry([]);

    expect(mockClearWorkspaceSchemas).toHaveBeenCalledTimes(1);
    expect(mockLoadBuiltinTrackers).toHaveBeenCalledTimes(1);
    expect(mockRegister).not.toHaveBeenCalled();
  });
});
