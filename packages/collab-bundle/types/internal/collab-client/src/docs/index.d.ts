export * from './collabDiscovery';
export * from './collabTree';
export * from './collabTypeResolver';
export * from './dataSource';
export * from './moveAcrossSections';
export * from './pageFields';
export * from './pageSearch';
export * from './session';
export * from './sharedHomeTab';
export type { SharedDocument, SharedFolder, SharedParentKind } from './types';
export type { PageTreeDragged, PageTreeDropPlan, PageTreeDropZone, PageTreeWrite } from './collabPageTree';
/** The one page tree's builder and move planner, loaded on demand so it stays out of the eager docs bundle. */
export declare const loadCollabPageTree: () => Promise<typeof import("./collabPageTree")>;
