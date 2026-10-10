/**
 * In-app confirm for a destructive action; resolves true on accept. Never use
 * `window.confirm`: it blocks the renderer and any E2E run driving it. The
 * dialog loads lazily, keeping it out of the docs-ui eager bundle.
 */
export const confirmDestructive = (title: string, message: string, confirmLabel = 'Delete'): Promise<boolean> =>
  import('./ConfirmModal').then((m) => m.openConfirm(title, message, confirmLabel));
