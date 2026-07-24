/**
 * Workspace-related types for the Electron app
 * These are application-level concepts that don't belong in the runtime
 */

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceRepository {
  list(): Promise<Workspace[]>;
  create(name: string): Promise<Workspace>;
  rename(id: string, name: string): Promise<void>;
}