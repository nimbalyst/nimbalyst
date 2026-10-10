import type { SavedViewDefinition, TrackerDataSource } from '../../trackers';
export declare function createViewItem(dataSource: TrackerDataSource, definition: SavedViewDefinition, title: string, groupFields?: Record<string, unknown>, requestId?: string): Promise<void>;
