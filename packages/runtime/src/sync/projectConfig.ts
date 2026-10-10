/**
 * Shared predicate for the project config blob.
 *
 * Lives next to the send site (CollabV3Sync) rather than in the desktop
 * composer, because the send site is what actually decides whether to encrypt
 * and transmit. Duplicating the condition in both places is how the two drift.
 */

import type { ProjectConfig } from './types';

/**
 * Whether the blob is encrypted and sent.
 *
 * The server keeps the stored blob when a `projectConfigUpdate` omits it, so
 * the blob is the only way a removal reaches the phone: a project that loses
 * its last command, action or its Local wiki must send an empty blob, or the
 * phone keeps the old one forever. So a whole config, stamped with its compose
 * time in `lastCommandsUpdate` (the desktop composer always stamps it), is
 * sent even when empty.
 *
 * What is not sent is an unstamped object with nothing in it: `gitRemoteHash`
 * rides its own plaintext field on the message, and a hash-only call must not
 * overwrite stored config with an empty object.
 */
export function hasPublishableConfig(config: ProjectConfig): boolean {
  return config.lastCommandsUpdate > 0
    || config.commands.length > 0 || (config.actions?.length ?? 0) > 0 || config.localWiki !== undefined;
}
