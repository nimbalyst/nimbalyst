/**
 * Shared preferred-agent-language configuration injected from the Electron
 * main process at startup (and on user changes). The runtime package can't
 * read electron-store directly, so the main process pushes the current value
 * here via setPreferredAgentLanguage(); providers and prompt builders read it
 * via getPreferredAgentLanguage().
 *
 * Module-level singleton state -- consistent with the static-field pattern
 * already used for MCP server ports across providers.
 */

let preferredAgentLanguage: string | undefined;

export function setPreferredAgentLanguage(language: string | undefined): void {
  if (language && language.trim().length > 0) {
    preferredAgentLanguage = language.trim();
  } else {
    preferredAgentLanguage = undefined;
  }
}

export function getPreferredAgentLanguage(): string | undefined {
  return preferredAgentLanguage;
}
