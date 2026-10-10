/**
 * A tracker body write that named the version it was based on, refused
 * because the stored body (`tracker_items.body_version`) moved on since.
 */
export class TrackerBodyVersionConflictError extends Error {
  readonly code = 'BODY_VERSION_CONFLICT';

  constructor(readonly itemId: string, readonly bodyVersion: number) {
    super(`The body of ${itemId} changed since it was read (now at version ${bodyVersion}).`);
    this.name = 'TrackerBodyVersionConflictError';
  }
}
