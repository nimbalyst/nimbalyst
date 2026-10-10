import { requestConfirmation } from '../../dialogs/requestConfirmation';

/** The host confirm the runtime tracker table and row menu call before deleting items. */
export function confirmTrackerItemDelete(itemCount: number): Promise<boolean> {
  return requestConfirmation({
    title: itemCount > 1 ? 'Delete items?' : 'Delete item?',
    message: `Delete ${itemCount} item${itemCount > 1 ? 's' : ''}? This cannot be undone.`,
    confirmLabel: 'Delete',
    destructive: true,
  });
}
