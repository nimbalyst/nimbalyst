/**
 * Renderer-safe port of
 * packages/runtime/src/ai/server/providers/documentContextUtils.ts.
 *
 * Only the helpers the Antigravity provider needs (isSlashCommand,
 * buildUserMessageAddition). The host passes documentContext through as
 * `unknown`; we read just the renderer-visible string fields off it.
 */

export interface MinimalDocumentContext {
  documentContextPrompt?: string;
  editingInstructions?: string;
  mode?: string;
  worktreePath?: string;
  mcpConfigWorkspacePath?: string;
  permissionsPath?: string;
}

const KNOWN_SLASH_COMMAND_PREFIXES = [
  '/commit',
  '/review',
  '/help',
  '/clear',
  '/context',
  '/compact',
  '/bug',
  '/track',
  '/plan',
  '/implement',
  '/release',
  '/release-alpha',
  '/promote-public-release',
  '/e2e',
  '/restart',
  '/mychanges',
  '/playwright',
  '/mockup',
  '/excalidraw',
  '/datamodel',
  '/posthog',
  '/extension',
];

export function isSlashCommand(message: string): boolean {
  const trimmed = message.trimStart();

  for (const prefix of KNOWN_SLASH_COMMAND_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return true;
    }
  }

  const slashCommandMatch = trimmed.match(/^\/[a-z][a-z0-9-]*/i);
  if (slashCommandMatch) {
    const matchEnd = slashCommandMatch[0].length;
    const nextChar = trimmed[matchEnd];
    if (nextChar === undefined || nextChar === ' ' || nextChar === '\n') {
      return true;
    }
  }

  return false;
}

export interface UserMessageAdditionResult {
  userMessageAddition: string | null;
  messageWithContext: string;
}

export function buildUserMessageAddition(
  message: string,
  documentContext?: MinimalDocumentContext
): UserMessageAdditionResult {
  if (isSlashCommand(message)) {
    return {
      userMessageAddition: null,
      messageWithContext: message,
    };
  }

  const documentContextPrompt = documentContext?.documentContextPrompt;
  const editingInstructions = documentContext?.editingInstructions;

  const parts: string[] = [];

  if (documentContextPrompt) {
    parts.push(documentContextPrompt);
  }

  if (editingInstructions) {
    parts.push(editingInstructions);
  }

  if (parts.length === 0) {
    return {
      userMessageAddition: null,
      messageWithContext: message,
    };
  }

  const userMessageAddition = parts.join('\n\n');
  const messageWithContext = `${message}\n\n<NIMBALYST_SYSTEM_MESSAGE>\n${userMessageAddition}\n</NIMBALYST_SYSTEM_MESSAGE>`;

  return {
    userMessageAddition,
    messageWithContext,
  };
}
