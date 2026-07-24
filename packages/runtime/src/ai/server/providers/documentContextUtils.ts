/**
 * Shared utilities for document context handling across AI providers.
 */

import type { DocumentContext } from '../types';

/**
 * Known slash command prefixes that should skip document context.
 * These are actual slash commands, not division expressions.
 */
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

/**
 * Check if a message is a slash command.
 * More specific than just checking for '/' to avoid false positives like "what is 10 / 5".
 */
export function isSlashCommand(message: string): boolean {
  const trimmed = message.trimStart();

  // Check if the message starts with a known slash command prefix
  for (const prefix of KNOWN_SLASH_COMMAND_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return true;
    }
  }

  // Also check for the pattern /word (no space after /)
  // This catches custom slash commands while avoiding division expressions
  const slashCommandMatch = trimmed.match(/^\/[a-z][a-z0-9-]*/i);
  if (slashCommandMatch) {
    // Additional check: if the next char after the match is a letter, it's likely a command
    const matchEnd = slashCommandMatch[0].length;
    const nextChar = trimmed[matchEnd];
    // If next char is space, end of string, or another word char, it's a command
    if (nextChar === undefined || nextChar === ' ' || nextChar === '\n') {
      return true;
    }
  }

  return false;
}

/**
 * Result of building user message addition.
 */
export interface UserMessageAdditionResult {
  /** The combined user message addition, or null if none */
  userMessageAddition: string | null;
  /** The modified message with context appended */
  messageWithContext: string;
}

/**
 * Build user message addition from document context.
 *
 * This function extracts the common pattern used across Claude, OpenAI, and LM Studio providers
 * to append document context to user messages.
 *
 * @param message - The original user message
 * @param documentContext - The document context (may contain pre-built prompts)
 * @returns The user message addition and modified message
 */
export function buildUserMessageAddition(
  message: string,
  documentContext?: DocumentContext
): UserMessageAdditionResult {
  // Skip adding system message if the prompt is a slash command
  if (isSlashCommand(message)) {
    return {
      userMessageAddition: null,
      messageWithContext: message,
    };
  }

  // Extract pre-built prompts from DocumentContextService
  const documentContextPrompt = documentContext?.documentContextPrompt;
  const editingInstructions = documentContext?.editingInstructions;

  // Build user message addition from pre-built prompts
  const parts: string[] = [];

  // Add document context prompt (file path, cursor, selection, content/diff, transitions)
  if (documentContextPrompt) {
    parts.push(documentContextPrompt);
  }

  // Add one-time editing instructions (only on first message with document open)
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
