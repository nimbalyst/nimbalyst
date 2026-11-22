/**
 * Lightweight types still consumed by the slash-picker (`UserCommand`)
 * and dynamic-options channels (`DynamicMenuOption`). The original
 * `PluginPackage` shape was retired in favor of `LexicalExtension`
 * instances published into the runtime extension stores.
 */

import type { AnyLexicalCommand } from 'lexical';

export interface UserCommand {
  /** Display name for the command */
  title: string;

  /** Optional description */
  description?: string;

  /** Optional icon (emoji or icon name) */
  icon?: string;

  /** Keywords for searching */
  keywords?: string[];

  /** The command to execute. Lexical 0.49+ made command payloads invariant,
   * so a specific `LexicalCommand<T>` is no longer assignable to
   * `LexicalCommand<unknown>`; `payload` is paired with it at dispatch. */
  command: AnyLexicalCommand;

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
