export interface TrackerCreationPublication {
  itemId: string;
  status: 'local' | 'pending' | 'published';
  error?: string;
  /** Original creation snapshot, available for copy if publication needs review. */
  savedContent?: string;
}
