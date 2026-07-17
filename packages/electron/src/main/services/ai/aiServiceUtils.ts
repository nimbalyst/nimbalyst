/**
 * Pure helper functions extracted from AIService.ts.
 *
 * Constraints:
 * - No `this` references — these are module-level utilities, not class methods.
 * - No IPC registration — that stays in AIService.
 * - Side-effect dependencies are injected via module imports (logger, historyManager, fs/path).
 */

import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import {
  OpenAICodexProvider,
  type AIProvider,
} from '@nimbalyst/runtime/ai/server';
import {
  ModelIdentifier,
  CLAUDE_CODE_VARIANTS,
  AI_PROVIDER_TYPES,
  type AIProviderType,
} from '@nimbalyst/runtime/ai/server/types';
import { logger } from '../../utils/logger';
import { historyManager } from '../../HistoryManager';

export const LOG_PREVIEW_LENGTH = 400;

/** Read file content as UTF-8. Returns '' for missing files, null for other errors. */
export async function readFileContentOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch (error: any) {
    return error?.code === 'ENOENT' ? '' : null;
  }
}

export function isCreateLikeChangeKind(kind: string | undefined): boolean {
  if (!kind) return false;
  const normalized = kind.toLowerCase();
  return normalized === 'create' || normalized === 'add' || normalized === 'new';
}

/**
 * Best-effort fallback baseline for files missing cache baseline (commonly gitignored files).
 * Prefers non-tag snapshots and skips snapshots that match current on-disk content.
 */
export async function recoverBaselineFromHistory(
  filePath: string,
  currentContent: string | null
): Promise<string | null> {
  try {
    const snapshots = await historyManager.listSnapshots(filePath);
    if (snapshots.length === 0) {
      return null;
    }

    // If there's a reviewed tag for this file, skip any snapshot older than
    // the review timestamp. This prevents returning stale pre-edit baselines
    // from before previously-accepted changes (tag resurrection bug).
    const lastReviewedAt = await historyManager.getLastReviewedTimestamp(filePath);

    const nonTagSnapshots = snapshots.filter((snapshot) => {
      const type = String(snapshot.metadata?.type ?? snapshot.type ?? '').toLowerCase();
      return type !== 'pre-edit' && type !== 'incremental-approval';
    });
    const orderedCandidates = [...nonTagSnapshots, ...snapshots];

    const seenTimestamps = new Set<string>();
    let checked = 0;
    for (const snapshot of orderedCandidates) {
      if (checked >= 8) break;
      if (seenTimestamps.has(snapshot.timestamp)) continue;
      seenTimestamps.add(snapshot.timestamp);
      checked++;

      // Skip snapshots from before the last review — they represent
      // pre-acceptance state and would cause baseline drift.
      // Also skip the reviewed pre-edit tag itself (timestamp ===
      // lastReviewedAt with type 'pre-edit'): its content is the BEFORE
      // state of an already-accepted edit, not a valid baseline for a new
      // edit. Returning it would produce a phantom diff for read-only
      // commands like `sed -n '1,200p' file` (the bash flow detects
      // "candidate != current" and creates a pending-review tag for a
      // command that didn't write anything), which then masks the real
      // pre_edit_snapshot's tag attribution because createTag dedupes by
      // (file, session) and keeps the speculative tag.
      if (lastReviewedAt !== null) {
        const snapshotTs = typeof snapshot.timestamp === 'string'
          ? parseInt(snapshot.timestamp, 10)
          : snapshot.timestamp;
        if (snapshotTs <= lastReviewedAt) {
          const snapshotType = String(snapshot.metadata?.type ?? snapshot.type ?? '').toLowerCase();
          if (snapshotTs < lastReviewedAt || snapshotType === 'pre-edit' || snapshotType === 'incremental-approval') {
            continue;
          }
        }
      }

      const candidateContent = await historyManager.loadSnapshot(filePath, snapshot.timestamp);
      if (currentContent !== null && candidateContent === currentContent) {
        continue;
      }
      return candidateContent;
    }

    return null;
  } catch (error) {
    logger.ai.debug('[AIService] Failed recovering baseline from history', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function previewForLog(value?: string, max: number = LOG_PREVIEW_LENGTH): string {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// Helper functions for bucketing analytics values
export function bucketMessageLength(length: number): 'short' | 'medium' | 'long' {
  if (length < 100) return 'short';
  if (length < 500) return 'medium';
  return 'long';
}

export function bucketResponseTime(ms: number): 'fast' | 'medium' | 'slow' {
  if (ms < 2000) return 'fast';
  if (ms < 5000) return 'medium';
  return 'slow';
}

export function bucketChunkCount(count: number): string {
  if (count < 10) return '0-9';
  if (count < 50) return '10-49';
  if (count < 100) return '50-99';
  return '100+';
}

export function bucketContentLength(length: number): string {
  if (length < 100) return '0-99';
  if (length < 500) return '100-499';
  if (length < 1000) return '500-999';
  return '1000+';
}

export function bucketCount(count: number): string {
  if (count === 0) return '0';
  if (count === 1) return '1';
  if (count < 5) return '2-4';
  if (count < 10) return '5-9';
  return '10+';
}

export function bucketAgeInDays(timestampMs: number): string {
  const ageMs = Date.now() - timestampMs;
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

  if (ageDays === 0) return 'today';
  if (ageDays === 1) return '1-day';
  if (ageDays < 7) return '2-6-days';
  if (ageDays < 30) return '1-4-weeks';
  if (ageDays < 90) return '1-3-months';
  return '3-months-plus';
}

/**
 * Detects which AI provider the user's shell environment is configured for.
 * Used ONLY for analytics telemetry — NOT for routing or billing decisions.
 * Nimbalyst never uses these env vars for API calls (see CLAUDE.md policy).
 *
 * Checks providers in order of specificity:
 * 1. Claude Code specific flags (Bedrock, Vertex) - most specific
 * 2. Other AI provider API keys
 * 3. Anthropic API key - checked last as it's the default/fallback
 */
export function detectConfiguredAIProvider(): string | null {
  // Claude Code specific providers (most specific - explicit flags)
  if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') return 'aws-bedrock';
  if (process.env.CLAUDE_CODE_USE_VERTEX === '1') return 'google-vertex';

  // Other AI providers (check before Anthropic as they're more specific)
  if (process.env.XAI_API_KEY) return 'xai';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.AZURE_OPENAI_API_KEY) return 'azure-openai';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.MISTRAL_API_KEY) return 'mistral';
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.COHERE_API_KEY) return 'cohere';

  // Anthropic direct API (check last as it's the default)
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';

  return null;
}

/**
 * Safely send a message to a WebContents from an IPC event.
 * Returns false if the sender was destroyed (e.g., window was refreshed/navigated).
 * Falls back to any live BrowserWindow so prompts still reach the UI after HMR.
 */
export function safeSend(event: Electron.IpcMainInvokeEvent, channel: string, ...args: unknown[]): boolean {
  if (!event.sender.isDestroyed()) {
    event.sender.send(channel, ...args);
    return true;
  }

  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  if (win) {
    logger.main.info(`[AIService] safeSend: original sender destroyed, falling back to window ${win.id} for ${channel}`);
    win.webContents.send(channel, ...args);
    return true;
  }

  logger.main.debug(`[AIService] Skipping ${channel} - no live windows`);
  return false;
}

/**
 * Extract file extension from a file path for analytics.
 * Handles compound extensions like .mockup.html
 */
export function getFileExtensionForAnalytics(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;

  const lowerPath = filePath.toLowerCase();

  if (lowerPath.endsWith('.mockup.html')) {
    return '.mockup.html';
  }

  const lastDot = filePath.lastIndexOf('.');
  return lastDot >= 0 ? filePath.substring(lastDot).toLowerCase() : undefined;
}

/**
 * Extract the model part from a full model ID for passing to provider APIs.
 * For claude-code, returns the full model (with suffix if any).
 * For other providers, strips the provider prefix.
 *
 * Returns null if the model is a Claude Code variant being used with a non-claude-code provider
 * (which indicates corrupt/migrated session data).
 */
export function extractModelForProvider(
  fullModel: string,
  provider: AIProviderType
): string | null {
  if (provider === 'openai-codex' || provider === 'openai-codex-acp') {
    const parsed = ModelIdentifier.tryParse(fullModel);
    const rawModel = parsed ? parsed.model : fullModel;
    const normalized = OpenAICodexProvider.normalizeModelSelection(rawModel);
    return normalized.replace(/^openai-codex:/, '');
  }

  if (provider === 'claude-code') {
    return fullModel;
  }

  const parsed = ModelIdentifier.tryParse(fullModel);
  if (parsed) {
    if (parsed.provider === 'claude-code') {
      logger.main.warn(`[AIService] Session has Claude Code model "${fullModel}" with ${provider} provider - using default model`);
      return null;
    }
    if (!parsed.model || parsed.model === parsed.provider) {
      logger.main.warn(`[AIService] Model "${fullModel}" appears to be just a provider name - using default model`);
      return null;
    }
    return parsed.model;
  }

  if (provider === 'claude' && (CLAUDE_CODE_VARIANTS as readonly string[]).includes(fullModel.toLowerCase())) {
    logger.main.warn(`[AIService] Session has Claude Code variant "${fullModel}" with claude provider - using default model`);
    return null;
  }

  if ((AI_PROVIDER_TYPES as readonly string[]).includes(fullModel.toLowerCase())) {
    logger.main.warn(`[AIService] Model "${fullModel}" is just a provider name, not a valid model ID - using default model`);
    return null;
  }

  return fullModel;
}

/**
 * Detect if a message starts with a Nimbalyst package slash command.
 *
 * NOTE: Tool packages have been replaced by extension-based Claude plugins.
 * This function now always returns null. Slash commands are handled by extensions.
 */
export function detectNimbalystSlashCommand(
  _message: string,
  _workspacePath: string | undefined
): { commandName: string; packageId: string } | null {
  return null;
}

/**
 * Extract file paths from @ mentions in a message.
 * Supports: @file.md, @path/to/file.ts, @"path with spaces/file.md"
 */
export function extractFileMentions(message: string): string[] {
  const mentionRegex = /@(?:"([^"]+)"|([^\s]+))/g;
  const mentions: string[] = [];
  let match;

  while ((match = mentionRegex.exec(message)) !== null) {
    const filePath = match[1] || match[2];
    if (filePath) {
      mentions.push(filePath);
    }
  }

  return mentions;
}

/** Check if a file is binary by sampling its first chunk for null bytes / control characters. */
export function isBinaryFile(filePath: string): boolean {
  try {
    const buffer = fs.readFileSync(filePath);
    const chunkSize = Math.min(512, buffer.length);

    for (let i = 0; i < chunkSize; i++) {
      const byte = buffer[i];
      if (byte === 0) return true;
      if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
        return true;
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

/**
 * Attach file contents for @ mentions in non-agent providers.
 * For providers that don't support file tools (supportsFileTools: false),
 * automatically read and attach @ referenced files to the message.
 */
export async function attachMentionedFiles(
  message: string,
  workspacePath: string,
  provider: AIProvider
): Promise<{ enhancedMessage: string; attachedFiles: Array<{ path: string; size: number }> }> {
  const capabilities = provider.getCapabilities();

  if (capabilities.supportsFileTools) {
    return { enhancedMessage: message, attachedFiles: [] };
  }

  const mentions = extractFileMentions(message);
  if (mentions.length === 0) {
    return { enhancedMessage: message, attachedFiles: [] };
  }

  logger.main.info(`[AIService] Found ${mentions.length} file @ mentions for non-agent provider`, { mentions });

  const MAX_FILE_SIZE = 1024 * 1024;
  const attachedFiles: Array<{ path: string; size: number }> = [];
  const fileContents: Array<{ path: string; content: string }> = [];

  for (const mentionedPath of mentions) {
    try {
      const fullPath = path.isAbsolute(mentionedPath)
        ? mentionedPath
        : path.join(workspacePath, mentionedPath);

      const resolvedPath = path.resolve(fullPath);
      const resolvedWorkspace = path.resolve(workspacePath);
      if (!resolvedPath.startsWith(resolvedWorkspace)) {
        logger.main.warn(`[AIService] Skipping @ mention outside workspace: ${mentionedPath}`);
        continue;
      }

      if (!fs.existsSync(resolvedPath)) {
        logger.main.warn(`[AIService] @ mentioned file not found: ${mentionedPath}`);
        continue;
      }

      const stats = fs.statSync(resolvedPath);
      if (stats.isDirectory()) {
        continue;
      }
      if (stats.size > MAX_FILE_SIZE) {
        logger.main.warn(`[AIService] @ mentioned file too large (${stats.size} bytes): ${mentionedPath}`);
        continue;
      }

      if (isBinaryFile(resolvedPath)) {
        logger.main.warn(`[AIService] @ mentioned file is binary, skipping: ${mentionedPath}`);
        continue;
      }

      const content = fs.readFileSync(resolvedPath, 'utf-8');
      fileContents.push({ path: mentionedPath, content });
      attachedFiles.push({ path: mentionedPath, size: stats.size });

      logger.main.info(`[AIService] Attached @ mentioned file: ${mentionedPath} (${stats.size} bytes)`);
    } catch (error) {
      logger.main.error(`[AIService] Error reading @ mentioned file ${mentionedPath}:`, error);
    }
  }

  if (fileContents.length === 0) {
    return { enhancedMessage: message, attachedFiles: [] };
  }

  let enhancedMessage = '';

  for (const { path: filePath, content } of fileContents) {
    enhancedMessage += `[File: ${filePath}]\n\`\`\`\n${content}\n\`\`\`\n\n`;
  }

  enhancedMessage += message;

  return { enhancedMessage, attachedFiles };
}

/**
 * Tag file before edit for non-agentic providers (OpenAI, LMStudio, etc.).
 * Creates a pre-edit tag in the history database with pending-review status.
 * This enables diff visualization and persistence across app restarts.
 */
export async function tagFileBeforeEdit(
  workspacePath: string,
  filePath: string,
  sessionId: string,
  toolUseId: string
): Promise<void> {
  try {
    const pendingTags = await historyManager.getPendingTags(filePath);

    if (pendingTags && pendingTags.length > 0) {
      logger.ai.debug('[AIService] Pre-edit tag already exists, skipping', {
        file: path.basename(filePath),
        existingTagId: pendingTags[0].id,
      });
      return;
    }

    const tagId = `ai-edit-pending-${sessionId}-${toolUseId}`;
    logger.ai.info('[AIService] Creating pre-edit tag', {
      file: path.basename(filePath),
      tagId,
    });

    const content = fs.readFileSync(filePath, 'utf-8');

    await historyManager.createTag(
      workspacePath,
      filePath,
      tagId,
      content,
      sessionId,
      toolUseId
    );

    await new Promise(resolve => setTimeout(resolve, 10));
  } catch (error) {
    const errorStr = String(error);
    if (errorStr.includes('unique') || errorStr.includes('UNIQUE') || errorStr.includes('duplicate')) {
      return;
    }
    logger.ai.error('[AIService] Failed to create pre-edit tag:', error);
  }
}

// Translate raw Codex CLI/SDK errors into user-friendly messages for the test connection UI.
export function formatCodexTestError(raw: string, hasApiKey: boolean): string {
  const lower = raw.toLowerCase();

  if (lower.includes('unauthorized') || lower.includes('401') || lower.includes('invalid api key') || lower.includes('incorrect api key')) {
    return hasApiKey
      ? 'Invalid API key. Check that your OpenAI API key is correct.'
      : 'Authentication failed. Try logging in with the Codex CLI or providing an API key.';
  }

  if (/exited with code \d+/i.test(raw)) {
    return hasApiKey
      ? 'Connection failed. The API key may be invalid or the Codex CLI encountered an error.'
      : 'Connection failed. Try logging in with the Codex CLI or providing a valid API key.';
  }

  if (lower.includes('econnrefused') || lower.includes('network') || lower.includes('fetch failed')) {
    return 'Network error. Check your internet connection and try again.';
  }

  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
    return 'Rate limited. Wait a moment and try again.';
  }

  return raw;
}

/**
 * Categorize AI errors into stable buckets for analytics.
 * Accepts either an Error-like object or a raw string (e.g. a chunk.error payload
 * that the provider yielded rather than threw).
 *
 * NIM-838: dedicated buckets for resume-mismatch and stream-closed checked first --
 * the generic 'auth'/'network' substrings can false-positive against long
 * concatenated error messages.
 */
export function categorizeAIError(error: any): string {
  const raw = typeof error === 'string' ? error : (error?.message || String(error ?? ''));
  const message = raw.toLowerCase();
  if (message.includes('session resume mismatch')) return 'resume_mismatch';
  if (message.includes('stream closed')) return 'stream_closed';
  if (message.includes('network') || message.includes('econnrefused') || message.includes('fetch')) return 'network';
  if (message.includes('api key') || message.includes('unauthorized') || message.includes('authentication')) return 'auth';
  if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
  if (message.includes('rate limit') || message.includes('too many requests')) return 'rate_limit';
  if (message.includes('overloaded') || message.includes('capacity')) return 'overloaded';
  return 'unknown';
}
