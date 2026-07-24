/**
 * DatamodelLM Extension Store
 *
 * A simplified Zustand store for the extension that works with file-based models.
 * Unlike the standalone DatamodelLM which persists to localStorage,
 * this store is initialized from file content and notifies the host when dirty.
 */

import { create } from 'zustand';
import type {
  Entity,
  Relationship,
  EntityViewMode,
  DataModelFile,
  Database,
} from './types';
import { autoLayoutEntitiesAsync } from './utils/autoLayout';

// Simple ID generator
function nanoid(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

/**
 * Store state interface
 */
interface DataModelStore {
  // Data model content
  entities: Entity[];
  relationships: Relationship[];
  database: Database;
  entityViewMode: EntityViewMode;
  viewport: { x: number; y: number; zoom: number };

  // Selection state
  selectedEntityId: string | null;
  selectedRelationshipId: string | null;
  hoveredEntityId: string | null;

  // Dirty tracking
  isDirty: boolean;
  /** True after loadFromFile completes and initial setup (like fitView) is done */
  hasCompletedInitialLoad: boolean;

  // Callbacks (set by the editor component)
  onDirtyChange?: (isDirty: boolean) => void;

  // Actions - Initialization
  loadFromFile: (data: DataModelFile) => void;
  toFileData: () => DataModelFile;
  setCallbacks: (callbacks: { onDirtyChange?: (isDirty: boolean) => void }) => void;
  /** Mark initial load as complete - dirty changes will now be reported */
  markInitialLoadComplete: () => void;

  // Actions - Entity management
  addEntity: (entity: Partial<Pick<Entity, 'id'>> & Omit<Entity, 'id'>) => void;
  updateEntity: (id: string, updates: Partial<Entity>) => void;
  deleteEntity: (id: string) => void;
  deleteEntities: (ids: string[]) => void;
  selectEntity: (id: string | null) => void;
  hoverEntity: (id: string | null) => void;

  // Actions - Relationship management
  addRelationship: (relationship: Partial<Pick<Relationship, 'id'>> & Omit<Relationship, 'id'>) => void;
  updateRelationship: (id: string, updates: Partial<Relationship>) => void;
  deleteRelationship: (id: string) => void;
  selectRelationship: (id: string | null) => void;

  // Actions - View control
  setViewport: (x: number, y: number, zoom: number) => void;
  setEntityViewMode: (mode: EntityViewMode) => void;
  setDatabase: (database: Database) => void;

  // Actions - Layout
  autoLayout: () => Promise<void>;

  // Actions - Reset dirty state (after save)
  markClean: () => void;
}

/**
 * Create a data model store instance.
 * Each editor instance gets its own store.
 */
export function createDataModelStore() {
  return create<DataModelStore>()((set, get) => ({
    // Initial state
    entities: [],
    relationships: [],
    database: 'postgres',
    entityViewMode: 'standard',
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedEntityId: null,
    selectedRelationshipId: null,
    hoveredEntityId: null,
    isDirty: false,
    hasCompletedInitialLoad: false,
    onDirtyChange: undefined,

    // Load from file content
    loadFromFile: (data: DataModelFile) => {
      set({
        entities: data.entities || [],
        relationships: data.relationships || [],
        database: data.database || 'postgres',
        entityViewMode: data.entityViewMode || 'standard',
        viewport: data.viewport || { x: 0, y: 0, zoom: 1 },
        isDirty: false,
        hasCompletedInitialLoad: false, // Will be set true after initial fitView completes
        selectedEntityId: null,
        selectedRelationshipId: null,
        hoveredEntityId: null,
      });
    },

    // Export to file format
    toFileData: (): DataModelFile => {
      const state = get();
      return {
        version: 1,
        database: state.database,
        entities: state.entities,
        relationships: state.relationships,
        viewport: state.viewport,
        entityViewMode: state.entityViewMode,
      };
    },

    // Set callbacks
    setCallbacks: (callbacks) => {
      set({ onDirtyChange: callbacks.onDirtyChange });
    },

    // Mark initial load as complete - dirty changes will now be reported
    markInitialLoadComplete: () => {
      set({ hasCompletedInitialLoad: true });
    },

    // Helper to mark dirty and notify
    // (internal use - called by mutations)

    // Entity management
    addEntity: (entity) => {
      const newEntity: Entity = {
        ...entity,
        id: entity.id || nanoid(),
      };
      set((state) => {
        const newState = {
          entities: [...state.entities, newEntity],
          isDirty: true,
        };
        state.onDirtyChange?.(true);
        return newState;
      });
    },

    updateEntity: (id, updates) => {
      set((state) => {
        const oldEntity = state.entities.find((e) => e.id === id);
        const oldName = oldEntity?.name;

        const entities = state.entities.map((entity) =>
          entity.id === id ? { ...entity, ...updates } : entity
        );

        // If entity name changed, update all relationships that reference it
        let relationships = state.relationships;
        if (updates.name && oldName && updates.name !== oldName) {
          const newName = updates.name;
          relationships = relationships.map((rel) => {
            const updatedRel = { ...rel };
            if (rel.sourceEntityName === oldName) {
              updatedRel.sourceEntityName = newName;
            }
            if (rel.targetEntityName === oldName) {
              updatedRel.targetEntityName = newName;
            }
            return updatedRel;
          });
        }

        state.onDirtyChange?.(true);
        return { entities, relationships, isDirty: true };
      });
    },

    deleteEntity: (id) => {
      set((state) => {
        const entityToDelete = state.entities.find((entity) => entity.id === id);
        const entities = state.entities.filter((entity) => entity.id !== id);
        const relationships = state.relationships.filter(
          (rel) =>
            rel.sourceEntityName !== entityToDelete?.name &&
            rel.targetEntityName !== entityToDelete?.name
        );

        state.onDirtyChange?.(true);
        return {
          entities,
          relationships,
          selectedEntityId: state.selectedEntityId === id ? null : state.selectedEntityId,
          isDirty: true,
        };
      });
    },

    deleteEntities: (ids) => {
      set((state) => {
        const idsSet = new Set(ids);
        const entitiesToDelete = state.entities.filter((entity) => idsSet.has(entity.id));
        const deletedNames = new Set(entitiesToDelete.map((e) => e.name));
        const entities = state.entities.filter((entity) => !idsSet.has(entity.id));
        const relationships = state.relationships.filter(
          (rel) =>
            !deletedNames.has(rel.sourceEntityName) &&
            !deletedNames.has(rel.targetEntityName)
        );

        state.onDirtyChange?.(true);
        return {
          entities,
          relationships,
          selectedEntityId: idsSet.has(state.selectedEntityId || '') ? null : state.selectedEntityId,
          isDirty: true,
        };
      });
    },

    selectEntity: (id) => {
      set({
        selectedEntityId: id,
        selectedRelationshipId: id ? null : get().selectedRelationshipId,
      });
    },

    hoverEntity: (id) => {
      set({ hoveredEntityId: id });
    },

    // Relationship management
    addRelationship: (relationship) => {
      const newRelationship: Relationship = {
        ...relationship,
        id: relationship.id || nanoid(),
      };
      set((state) => {
        state.onDirtyChange?.(true);
        return {
          relationships: [...state.relationships, newRelationship],
          isDirty: true,
        };
      });
    },

    updateRelationship: (id, updates) => {
      set((state) => {
        const relationships = state.relationships.map((rel) =>
          rel.id === id ? { ...rel, ...updates } : rel
        );
        state.onDirtyChange?.(true);
        return { relationships, isDirty: true };
      });
    },

    deleteRelationship: (id) => {
      set((state) => {
        const relationships = state.relationships.filter((rel) => rel.id !== id);
        state.onDirtyChange?.(true);
        return {
          relationships,
          selectedRelationshipId: state.selectedRelationshipId === id ? null : state.selectedRelationshipId,
          isDirty: true,
        };
      });
    },

    selectRelationship: (id) => {
      set({
        selectedRelationshipId: id,
        selectedEntityId: id ? null : get().selectedEntityId,
      });
    },

    // View control
    setViewport: (x, y, zoom) => {
      set((state) => {
        // Skip dirty notification during initial load (fitView can trigger this)
        if (state.hasCompletedInitialLoad) {
          state.onDirtyChange?.(true);
          return { viewport: { x, y, zoom }, isDirty: true };
        }
        // During initial load, just update viewport without marking dirty
        return { viewport: { x, y, zoom } };
      });
    },

    setEntityViewMode: (mode) => {
      set((state) => {
        state.onDirtyChange?.(true);
        return { entityViewMode: mode, isDirty: true };
      });
    },

    setDatabase: (database) => {
      set((state) => {
        state.onDirtyChange?.(true);
        return { database, isDirty: true };
      });
    },

    // Auto-layout entities based on relationships
    autoLayout: async () => {
      const { entities, relationships, entityViewMode } = get();
      const positions = await autoLayoutEntitiesAsync(entities, relationships, entityViewMode);
      set((state) => {
        const updated = state.entities.map((entity) => {
          const newPos = positions.get(entity.id);
          return newPos ? { ...entity, position: newPos } : entity;
        });
        state.onDirtyChange?.(true);
        return { entities: updated, isDirty: true };
      });
    },

    // Reset dirty state after save
    markClean: () => {
      set({ isDirty: false });
    },
  }));
}

// Type for the store
export type DataModelStoreApi = ReturnType<typeof createDataModelStore>;
