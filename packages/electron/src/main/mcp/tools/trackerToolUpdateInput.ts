/** Validate the mutation target before looking up or preparing any item. */
export function prepareTrackerUpdateInput(args: any): void {
  if (typeof args?.id !== 'string' || !args.id.trim()) {
    throw new Error('tracker_update requires a non-empty string id. Use id, not itemId.');
  }

  // A description in the generic fields bag must seed the canonical body just
  // like a top-level description, without also writing data.description.
  if (
    args.fields &&
    typeof args.fields === 'object' &&
    args.fields.description !== undefined &&
    args.description === undefined
  ) {
    args.description = args.fields.description;
    delete args.fields.description;
  }
}
