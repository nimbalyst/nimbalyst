/**
 * Shared predicate for the project config blob.
 *
 * Lives next to the send site (CollabV3Sync) rather than in the desktop
 * composer, because the send site is what actually decides whether to encrypt
 * and transmit. Duplicating the condition in both places is how the two drift.
 */

import type { ProjectConfig } from './types';

/**
 * Whether the blob carries anything worth encrypting and sending.
 *
 * This replaced a `commands.length > 0` test. That test meant a workspace with
 * action prompts but no slash commands never published a blob at all — a
 * failure invisible on any repo that happens to have slash commands.
 *
 * `gitRemoteHash` is excluded on purpose: it rides its own plaintext field on
 * the `projectConfigUpdate` message and does not need the encrypted blob to
 * travel. Including it here would make a hash-only call overwrite existing
 * config with an otherwise-empty object.
 */
export function hasPublishableConfig(config: ProjectConfig): boolean {
  return config.commands.length > 0 || (config.actions?.length ?? 0) > 0;
}
