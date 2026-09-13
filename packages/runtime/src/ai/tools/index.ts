/**
 * Barrel for the AI tool layer. Importing this pulls in the renderer-side
 * document-editing handlers along with the schemas, so anything that runs
 * without an editor — the AI server layer, the Electron main process, a
 * headless host — should import `./definitions` directly instead.
 */

export * from './definitions';
export * from './documentEditingExecutor';
