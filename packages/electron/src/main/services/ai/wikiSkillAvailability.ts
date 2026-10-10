import { getClaudePluginEnabled, getExtensionEnabled } from '../../utils/store';

/** The extension that ships the wiki skills (/wiki:setup, /wiki:update). Its id predates the rename. */
const WIKI_EXTENSION_ID = 'com.nimbalyst.knowledge';

/**
 * Whether agents have the wiki skills: the extension is on (off by default)
 * and its Claude plugin has not been turned off (on by default).
 */
export function isWikiSkillAvailable(): boolean {
  return getExtensionEnabled(WIKI_EXTENSION_ID, false) && (getClaudePluginEnabled(WIKI_EXTENSION_ID) ?? true);
}
