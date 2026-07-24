/**
 * Origin tag used when the SDK wraps `initializeFromContent` in a Y.Doc
 * transaction. Extension bindings can compare a transaction's origin
 * against this to suppress their own change handlers during seeding
 * (otherwise the binding would echo the seed back into local-edit state).
 *
 * ```ts
 * yDoc.on('update', (update, origin) => {
 *   if (origin === COLLAB_INIT_ORIGIN) return;
 *   // ... apply remote change
 * });
 * ```
 */
export const COLLAB_INIT_ORIGIN = Symbol('nimbalyst:collab-init');
