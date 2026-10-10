/**
 * In-app confirm for a destructive action; resolves true on accept. Never use
 * `window.confirm`: it blocks the renderer and any E2E run driving it. The
 * dialog loads lazily, keeping it out of the docs-ui eager bundle.
 */
export declare const confirmDestructive: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
