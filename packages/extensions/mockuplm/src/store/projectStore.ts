/**
 * MockupLM Project Store
 *
 * Zustand store for managing .mockupproject files.
 * Follows the DataModelLM pattern: factory per editor instance,
 * loadFromFile/toFileData lifecycle, dirty tracking with initial load guard.
 */

import { create } from 'zustand';
import type {
  MockupReference,
  Connection,
  DesignSystemRef,
  MockupProjectFile,
} from '../types/project';

function nanoid(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

const DEFAULT_MOCKUP_SIZE = { width: 400, height: 300 };

interface MockupProjectStore {
  // Content
  name: string;
  description: string;
  designSystem: DesignSystemRef | undefined;
  mockups: MockupReference[];
  connections: Connection[];
  viewport: { x: number; y: number; zoom: number };

  // Selection
  selectedMockupId: string | null;
  selectedConnectionId: string | null;

  // Dirty tracking
  isDirty: boolean;
  hasCompletedInitialLoad: boolean;
  onDirtyChange?: (isDirty: boolean) => void;

  // Lifecycle
  loadFromFile: (data: MockupProjectFile) => void;
  toFileData: () => MockupProjectFile;
  setCallbacks: (callbacks: { onDirtyChange?: (isDirty: boolean) => void }) => void;
  markInitialLoadComplete: () => void;
  markClean: () => void;

  // Mockup management
  addMockup: (mockup: Partial<MockupReference> & Pick<MockupReference, 'path' | 'label'>) => void;
  updateMockup: (id: string, updates: Partial<MockupReference>) => void;
  deleteMockup: (id: string) => void;
  selectMockup: (id: string | null) => void;

  // Connection management
  addConnection: (conn: Omit<Connection, 'id'>) => void;
  updateConnection: (id: string, updates: Partial<Connection>) => void;
  deleteConnection: (id: string) => void;
  selectConnection: (id: string | null) => void;

  // Project metadata
  setName: (name: string) => void;
  setDescription: (description: string) => void;
  setDesignSystem: (ds: DesignSystemRef | undefined) => void;

  // View
  setViewport: (x: number, y: number, zoom: number) => void;

  // Layout
  autoLayout: () => void;
}

export function createMockupProjectStore() {
  return create<MockupProjectStore>()((set, get) => ({
    // Initial state
    name: 'New Project',
    description: '',
    designSystem: undefined,
    mockups: [],
    connections: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedMockupId: null,
    selectedConnectionId: null,
    isDirty: false,
    hasCompletedInitialLoad: false,
    onDirtyChange: undefined,

    loadFromFile: (data: MockupProjectFile) => {
      set({
        name: data.name || 'New Project',
        description: data.description || '',
        designSystem: data.designSystem,
        mockups: data.mockups || [],
        connections: data.connections || [],
        viewport: data.viewport || { x: 0, y: 0, zoom: 1 },
        isDirty: false,
        hasCompletedInitialLoad: false,
        selectedMockupId: null,
        selectedConnectionId: null,
      });
    },

    toFileData: (): MockupProjectFile => {
      const state = get();
      return {
        version: 1,
        name: state.name,
        description: state.description || undefined,
        designSystem: state.designSystem,
        mockups: state.mockups,
        connections: state.connections,
        viewport: state.viewport,
      };
    },

    setCallbacks: (callbacks) => {
      set({ onDirtyChange: callbacks.onDirtyChange });
    },

    markInitialLoadComplete: () => {
      set({ hasCompletedInitialLoad: true });
    },

    markClean: () => {
      set({ isDirty: false });
    },

    // Mockup management
    addMockup: (mockup) => {
      const newMockup: MockupReference = {
        id: mockup.id || nanoid(),
        path: mockup.path,
        label: mockup.label,
        position: mockup.position || { x: 100, y: 100 },
        size: mockup.size || DEFAULT_MOCKUP_SIZE,
      };
      set((state) => {
        state.onDirtyChange?.(true);
        return { mockups: [...state.mockups, newMockup], isDirty: true };
      });
    },

    updateMockup: (id, updates) => {
      set((state) => {
        const mockups = state.mockups.map((m) =>
          m.id === id ? { ...m, ...updates } : m
        );
        state.onDirtyChange?.(true);
        return { mockups, isDirty: true };
      });
    },

    deleteMockup: (id) => {
      set((state) => {
        const mockups = state.mockups.filter((m) => m.id !== id);
        const connections = state.connections.filter(
          (c) => c.fromMockupId !== id && c.toMockupId !== id
        );
        state.onDirtyChange?.(true);
        return {
          mockups,
          connections,
          selectedMockupId: state.selectedMockupId === id ? null : state.selectedMockupId,
          isDirty: true,
        };
      });
    },

    selectMockup: (id) => {
      set({
        selectedMockupId: id,
        selectedConnectionId: id ? null : get().selectedConnectionId,
      });
    },

    // Connection management
    addConnection: (conn) => {
      const newConn: Connection = { ...conn, id: nanoid() };
      set((state) => {
        state.onDirtyChange?.(true);
        return { connections: [...state.connections, newConn], isDirty: true };
      });
    },

    updateConnection: (id, updates) => {
      set((state) => {
        const connections = state.connections.map((c) =>
          c.id === id ? { ...c, ...updates } : c
        );
        state.onDirtyChange?.(true);
        return { connections, isDirty: true };
      });
    },

    deleteConnection: (id) => {
      set((state) => {
        const connections = state.connections.filter((c) => c.id !== id);
        state.onDirtyChange?.(true);
        return {
          connections,
          selectedConnectionId: state.selectedConnectionId === id ? null : state.selectedConnectionId,
          isDirty: true,
        };
      });
    },

    selectConnection: (id) => {
      set({
        selectedConnectionId: id,
        selectedMockupId: id ? null : get().selectedMockupId,
      });
    },

    // Project metadata
    setName: (name) => {
      set((state) => {
        state.onDirtyChange?.(true);
        return { name, isDirty: true };
      });
    },

    setDescription: (description) => {
      set((state) => {
        state.onDirtyChange?.(true);
        return { description, isDirty: true };
      });
    },

    setDesignSystem: (ds) => {
      set((state) => {
        state.onDirtyChange?.(true);
        return { designSystem: ds, isDirty: true };
      });
    },

    // View
    setViewport: (x, y, zoom) => {
      set((state) => {
        if (state.hasCompletedInitialLoad) {
          state.onDirtyChange?.(true);
          return { viewport: { x, y, zoom }, isDirty: true };
        }
        return { viewport: { x, y, zoom } };
      });
    },

    // Auto-layout: simple grid arrangement
    autoLayout: () => {
      const { mockups } = get();
      const cols = Math.ceil(Math.sqrt(mockups.length));
      const gapX = 500;
      const gapY = 400;
      const updated = mockups.map((m, i) => ({
        ...m,
        position: {
          x: (i % cols) * gapX,
          y: Math.floor(i / cols) * gapY,
        },
      }));
      set((state) => {
        state.onDirtyChange?.(true);
        return { mockups: updated, isDirty: true };
      });
    },
  }));
}

export type MockupProjectStoreApi = ReturnType<typeof createMockupProjectStore>;
