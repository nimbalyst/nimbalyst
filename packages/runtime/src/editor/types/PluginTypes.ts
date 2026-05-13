/**
 * Lightweight types still consumed by the slash-picker (`UserCommand`)
 * and dynamic-options channels (`DynamicMenuOption`). The original
 * `PluginPackage` shape was retired in favor of `LexicalExtension`
 * instances published into the runtime extension stores.
 */

import type { LexicalCommand } from 'lexical';

export interface UserCommand {
  /** Display name for the command */
  title: string;

  /** Optional description */
  description?: string;

  /** Optional icon (emoji or icon name) */
  icon?: string;

  /** Keywords for searching */
  keywords?: string[];

  /** The command to execute */
  command: LexicalCommand<unknown>;

  /** Optional payload for the command */
  payload?: unknown;
}

/** Dynamic option for the component picker menu */
export interface DynamicMenuOption {
  id: string;
  label: string;
  icon?: string;
  description?: string;
  keywords?: string[];
  onSelect: () => void;
}
