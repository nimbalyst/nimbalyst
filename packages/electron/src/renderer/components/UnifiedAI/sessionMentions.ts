import type { SessionMeta } from '@nimbalyst/runtime';

/** Expand compact composer mentions to the full ids consumed by agents/tools. */
export function expandSessionMentions(
  message: string,
  registry: Map<string, SessionMeta>,
): string {
  return message.replace(/@@\[([^\]]+)\]\(([a-f0-9]+)\)/g, (match, name, shortId) => {
    for (const [fullId] of registry) {
      if (fullId.startsWith(shortId)) {
        return `@@[${name}](${fullId})`;
      }
    }
    return match;
  });
}
