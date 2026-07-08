/**
 * Service to synchronize Claude Code sessions to Nimbalyst database
 *
 * This service handles the transformation and import of Claude Code JSONL sessions
 * into Nimbalyst's PGLite database format.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { type SessionStore, slimClaudeCodeChunkForStorage } from '@nimbalyst/runtime';
import type { AgentMessagesStore } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { DEFAULT_MODELS } from '@nimbalyst/runtime/ai/modelConstants';
import { logger } from '../utils/logger';
import { encodeWorkspaceDir, extractSessionMetadata, type ClaudeCodeEntry, type SessionMetadata } from './ClaudeCodeSessionScanner';

const log = logger.aiSession;

export interface SyncStatus {
  sessionId: string;
  status: 'new' | 'up-to-date' | 'needs-update';
  dbMessageCount: number;
  fileMessageCount: number;
}

export interface SyncResult {
  sessionId: string;
  success: boolean;
  error?: string;
  messagesAdded: number;
}

/** See ClaudeCodeSessionScanner.getClaudeProjectsDir for override semantics. */
function projectsDir(): string {
  return process.env.NIMBALYST_CLAUDE_PROJECTS_DIR || path.join(homedir(), '.claude', 'projects');
}

/**
 * Get the full path to a session JSONL file. Must use the same encoder as
 * the scanner -- otherwise the importer reads from a different directory
 * than the one the scanner found and every sync fails with ENOENT.
 */
function getSessionFilePath(workspacePath: string, sessionId: string): string {
  return path.join(projectsDir(), encodeWorkspaceDir(workspacePath), `${sessionId}.jsonl`);
}

/**
 * Get the per-session sidecar directory for subagent JSONLs and externalised
 * tool results. Lives next to the main `<sessionId>.jsonl`.
 */
function getSessionSidecarDir(workspacePath: string, sessionId: string): string {
  return path.join(projectsDir(), encodeWorkspaceDir(workspacePath), sessionId);
}

interface SubagentSidecar {
  /** Agent id from the file name (matches the spawning Task/Agent tool_use.id). */
  agentId: string;
  /** Parsed JSONL entries. */
  entries: ClaudeCodeEntry[];
  /** Merged contents of `agent-<id>.meta.json` (agentType, description). */
  meta: { agentType?: string; description?: string } | null;
}

/**
 * Read every subagent JSONL under `<sessionId>/subagents/`. Returns one
 * record per file with the agent id parsed out of the file name.
 */
async function readSubagentSidecars(
  workspacePath: string,
  sessionId: string,
): Promise<SubagentSidecar[]> {
  const subagentsDir = path.join(getSessionSidecarDir(workspacePath, sessionId), 'subagents');
  let dirents: import('fs').Dirent[];
  try {
    dirents = await fs.readdir(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const jsonlFiles = dirents
    .filter(d => d.isFile() && d.name.startsWith('agent-') && d.name.endsWith('.jsonl'));

  const sidecars: SubagentSidecar[] = [];
  for (const dirent of jsonlFiles) {
    const filePath = path.join(subagentsDir, dirent.name);
    const baseName = dirent.name.slice('agent-'.length, -'.jsonl'.length);
    // Compaction subagent files are named `agent-acompact-<hash>.jsonl`. The
    // canonical parser treats these like any other subagent.
    const agentId = baseName;

    const entries = await parseSessionFile(filePath).catch(() => [] as ClaudeCodeEntry[]);
    const metaPath = path.join(subagentsDir, `agent-${agentId}.meta.json`);
    let meta: SubagentSidecar['meta'] = null;
    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      meta = JSON.parse(raw);
    } catch {
      // meta.json is optional
    }

    sidecars.push({ agentId, entries, meta });
  }
  return sidecars;
}

/**
 * Convert subagent JSONL entries into raw messages on the parent session.
 *
 * Each emitted message sets `parent_tool_use_id = <agentId>` so the live
 * `ClaudeCodeRawParser` resolves them via its existing
 * `context.hasSubagent(parentToolUseId)` path. This means subagent messages
 * appear under the same `subagent_id` canonical event as the spawning
 * `Agent`/`Task` tool call -- matching how live runs are stored today.
 */
function buildSubagentMessages(
  sidecars: SubagentSidecar[],
): Array<{ direction: 'input' | 'output'; content: string; metadata: any; timestamp: string }> {
  const out: Array<{ direction: 'input' | 'output'; content: string; metadata: any; timestamp: string }> = [];

  for (const sidecar of sidecars) {
    for (const entry of sidecar.entries) {
      const msg = entryToMessage(entry);
      if (!msg) continue;

      // Override the subagent linkage. We rewrite the JSON content payload to
      // include `parent_tool_use_id = sidecar.agentId` so the canonical
      // parser routes downstream events under that subagent.
      try {
        const payload = JSON.parse(msg.content);
        payload.parent_tool_use_id = sidecar.agentId;
        msg.content = JSON.stringify(payload);
      } catch {
        // If the content isn't JSON for some reason, drop it -- the parser
        // can't make a useful canonical event from it without the linkage.
        continue;
      }
      out.push(msg);
    }
  }

  return out;
}

/**
 * Parse JSONL file and return all entries
 */
async function parseSessionFile(filePath: string): Promise<ClaudeCodeEntry[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    const entries: ClaudeCodeEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        entries.push(entry);
      } catch (error) {
        log.warn(`Failed to parse JSONL line: ${line.slice(0, 100)}...`);
      }
    }

    return entries;
  } catch (error) {
    log.error(`Failed to read session file ${filePath}:`, error);
    throw error;
  }
}

/**
 * Claude Code 2.1.x stashes large tool results in
 * `<sessionId>/tool-results/<id>.txt` and inlines a `<persisted-output>`
 * marker into the JSONL with a path back to the file. If we don't load the
 * external file the imported transcript shows only the 2KB preview.
 *
 * This walks every `tool_result` block on the entry, detects the marker,
 * and rewrites the block's content with the full file contents.
 */
async function inlinePersistedOutputs(entry: ClaudeCodeEntry): Promise<void> {
  const message = entry.message;
  if (!message) return;
  const content = message.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!block || block.type !== 'tool_result') continue;

    if (typeof block.content === 'string') {
      const replacement = await loadPersistedOutput(block.content);
      if (replacement !== null) block.content = replacement;
    } else if (Array.isArray(block.content)) {
      for (const inner of block.content) {
        if (inner && inner.type === 'text' && typeof inner.text === 'string') {
          const replacement = await loadPersistedOutput(inner.text);
          if (replacement !== null) inner.text = replacement;
        }
      }
    }
  }
}

const PERSISTED_OUTPUT_PATTERN = /<persisted-output>[\s\S]*?Full output saved to:\s*(.+?)\s*\n[\s\S]*?<\/persisted-output>/;

async function loadPersistedOutput(text: string): Promise<string | null> {
  const match = text.match(PERSISTED_OUTPUT_PATTERN);
  if (!match) return null;
  const externalPath = match[1].trim();
  if (!externalPath || !path.isAbsolute(externalPath)) return null;
  try {
    const data = await fs.readFile(externalPath, 'utf-8');
    return data;
  } catch (error: any) {
    log.warn(`Failed to inline persisted-output from ${externalPath}: ${error?.message ?? error}`);
    return null;
  }
}

/**
 * Map a Claude Code session's per-turn model id to a claude-code variant.
 *
 * Claude Code JSONL records the model on each assistant entry (e.g.
 * "claude-opus-4-7", new in 2.1.x). Imports previously stored no model at all,
 * so the renderer fell back to a hardcoded `claude-code:sonnet` and every
 * imported session showed Sonnet regardless of the model actually used (#394).
 * Walk the entries newest-first and return the most recent recognisable model
 * as a `claude-code:<variant>` string; undefined when none carry a model.
 */
export function importedClaudeCodeModel(entries: ClaudeCodeEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const raw = entries[i]?.message?.model;
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const id = raw.toLowerCase();
    if (id.includes('opus')) return 'claude-code:opus';
    if (id.includes('sonnet')) return 'claude-code:sonnet';
    if (id.includes('haiku')) return 'claude-code:haiku';
  }
  return undefined;
}

/**
 * Convert Claude Code JSONL entry to Nimbalyst message format
 *
 * IMPORTANT: This must produce the SAME format as ClaudeCodeProvider.logAgentMessage()
 * so that the canonical transcript system can parse it correctly.
 *
 * Live session format examples:
 * - Input: { prompt: "...", options: {...} }
 * - Output (text): { type: "text", content: "..." }
 * - Output (assistant): { type: "assistant", message: { content: [...], ... } }
 * - Output (user/tool result): { type: "user", message: { role: "user", content: [...] }, ... }
 * - Output (attachment): { type: "attachment", attachment: {...}, uuid, session_id }
 */
function entryToMessage(entry: ClaudeCodeEntry): { direction: 'input' | 'output'; content: string; metadata: any; timestamp: string } | null {
  // Named branches for non-conversational entry types. Each is handled
  // explicitly so future format changes are easy to spot.
  switch (entry.type) {
    case 'queue-operation':
      // Internal SDK enqueue/dequeue bookkeeping. No transcript value.
      return null;
    case 'last-prompt':
      // Rolling bookmark of the most recent user prompt. Already covered by
      // the actual user-message entry; importing it would duplicate.
      return null;
    case 'file-history-snapshot':
      // AI file-edit snapshot. Belongs to the file-history pipeline, not the
      // chat transcript.
      return null;
    case 'summary':
      // LLM-generated session summary. Used as a title source by the scanner;
      // not surfaced as a transcript message.
      return null;
    case 'attachment':
      return attachmentToMessage(entry);
    case 'system':
      // Standalone system messages from the CLI -- preserved as raw output
      // so the canonical parser can render them as system_message events.
      return systemEntryToMessage(entry);
    case 'user':
    case 'assistant':
      break; // fall through to conversational handling below
    default:
      return null;
  }

  // Skip meta messages (command outputs, caveats, etc.) - these clutter the transcript
  if (entry.isMeta) {
    return null;
  }

  const timestamp = entry.timestamp ?? new Date().toISOString();

  // Identify a "real" user prompt by content shape, not by parentUuid.
  // Claude Code 2.1.x links every entry to its predecessor via parentUuid,
  // so prompts after the first turn carry one too. A user entry is a prompt
  // when its content is text-only (string or text-only array, no
  // tool_result blocks) AND it doesn't look like CLI bookkeeping
  // (command name/output/caveat/system-reminder wrappers).
  const isUserPromptInput = entry.type === 'user' &&
    !!entry.message?.content &&
    isPlainTextContent(entry.message.content) &&
    !isCliBookkeepingText(extractTextContent(entry.message.content));

  if (isUserPromptInput) {
    // This is a user INPUT message - format like ClaudeCodeProvider does for input
    // Extract the prompt text
    let promptText = '';
    if (typeof entry.message?.content === 'string') {
      promptText = entry.message.content;
    } else if (Array.isArray(entry.message?.content)) {
      const textParts = entry.message.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text);
      promptText = textParts.join('\n');
    }

    // Skip empty messages
    if (!promptText.trim()) {
      return null;
    }

    // Format as ClaudeCodeProvider does: { prompt: "...", options: {...} }
    return {
      direction: 'input',
      content: JSON.stringify({
        prompt: promptText,
        options: {
          cwd: entry.cwd,
        }
      }),
      timestamp,
      metadata: null,
    };
  }

  if (entry.type === 'user') {
    // This is a user message in an OUTPUT context (tool result or system message)
    // Format like ClaudeCodeProvider does: { type: "user", message: {...}, ... }

    // Check if this is a tool result message
    const hasToolResults = Array.isArray(entry.message?.content) &&
      entry.message.content.some((p: any) => p.type === 'tool_result');

    if (hasToolResults) {
      // Tool result - store in the standard agent message format. Slim the
      // tool_use_result sidecar (originalFile / patch / redundant old/new strings)
      // the same way the live persistence path does -- nothing reads it and it's
      // the bulk of claude-code raw-log bloat.
      return {
        direction: 'output',
        content: JSON.stringify(slimClaudeCodeChunkForStorage({
          type: 'user',
          message: entry.message,
          session_id: entry.sessionId,
          uuid: entry.uuid,
          tool_use_result: (entry as any).toolUseResult,
        })),
        timestamp,
        metadata: null,
      };
    }

    // Other user message in output context (e.g., local command stdout)
    return {
      direction: 'output',
      content: JSON.stringify({
        type: 'user',
        message: entry.message,
        session_id: entry.sessionId,
        uuid: entry.uuid,
      }),
      timestamp,
      metadata: null,
    };
  }

  if (entry.type === 'assistant') {
    // Assistant message - store in the standard agent message format
    // Format: { type: "assistant", message: {...}, session_id: "...", uuid: "..." }

    // Skip if no message content
    if (!entry.message) {
      return null;
    }

    return {
      direction: 'output',
      content: JSON.stringify({
        type: 'assistant',
        message: entry.message,
        parent_tool_use_id: (entry as any).parentToolUseId || null,
        session_id: entry.sessionId,
        uuid: entry.uuid,
      }),
      timestamp,
      metadata: null,
    };
  }

  return null;
}

/**
 * A user entry is a real prompt when its content is text-only -- either a
 * plain string or an array whose blocks are all text. Anything carrying a
 * `tool_result` block is a tool response, not a prompt.
 */
function isPlainTextContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    if (content.length === 0) return false;
    if (content.some((b: any) => b?.type === 'tool_result')) return false;
    return content.every((b: any) => b?.type === 'text');
  }
  return false;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}

/**
 * Detect CLI bookkeeping wrapped inside user-role messages: slash commands
 * (`<command-name>`, `<command-message>`), local command stdout, caveats,
 * and system reminders. These look like user input but are CLI-generated
 * metadata, so we route them through the system_message canonical path
 * instead of the prompt path.
 */
function isCliBookkeepingText(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('<command-name>') ||
    lower.includes('<command-message>') ||
    lower.includes('<local-command-stdout>') ||
    lower.includes('<local-command-caveat>') ||
    lower.includes('<system-reminder>') ||
    lower.includes('<nimbalyst_system_message>') ||
    lower.includes('caveat: the messages below were generated')
  );
}

/**
 * Translate an `attachment` entry (mid-session context delta) into a raw
 * output message. The canonical parser turns these into `system_message`
 * events with a deterministic summary -- see ClaudeCodeRawParser.
 */
function attachmentToMessage(
  entry: ClaudeCodeEntry,
): { direction: 'output'; content: string; metadata: any; timestamp: string } | null {
  if (!entry.attachment) return null;
  return {
    direction: 'output',
    content: JSON.stringify({
      type: 'attachment',
      attachment: entry.attachment,
      session_id: entry.sessionId,
      uuid: entry.uuid,
    }),
    timestamp: entry.timestamp ?? new Date().toISOString(),
    metadata: null,
  };
}

/**
 * Translate a top-level `system` entry into a raw output message that the
 * canonical parser renders as a system_message.
 */
function systemEntryToMessage(
  entry: ClaudeCodeEntry,
): { direction: 'output'; content: string; metadata: any; timestamp: string } | null {
  if (!entry.message) return null;
  const content = entry.message.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
            .map((part: any) => part.text)
            .join('\n')
        : '';
  if (!text.trim()) return null;
  return {
    direction: 'output',
    content: JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
      session_id: entry.sessionId,
      uuid: entry.uuid,
    }),
    timestamp: entry.timestamp ?? new Date().toISOString(),
    metadata: null,
  };
}

/**
 * Check sync status for a session
 */
export async function checkSyncStatus(
  sessionStore: SessionStore,
  messagesStore: AgentMessagesStore,
  metadata: SessionMetadata
): Promise<SyncStatus> {
  try {
    // NOTE: Nimbalyst sessions store the Claude Code session ID in providerSessionId,
    // not in the main id field. We need to find the session by providerSessionId.
    // For now, we'll check by the main ID first (for imported sessions),
    // but we need a way to query by providerSessionId.

    // Try to find by main ID (works for already-imported sessions)
    let existingSession = await sessionStore.get(metadata.sessionId);

    // If not found, we need to check if a session exists with this as providerSessionId
    // Unfortunately, the SessionStore interface doesn't have a query-by-providerSessionId method
    // So for now, we'll have to list all sessions and check
    // TODO: Add a more efficient query method to SessionStore
    if (!existingSession) {
      // This is inefficient but necessary for now
      // We can't easily query by providerSessionId without modifying the store interface
      log.debug(`Session ${metadata.sessionId} not found by ID, may exist with providerSessionId`);
    }

    log.debug(`Checking sync status for session ${metadata.sessionId}: ${existingSession ? 'found in DB' : 'not in DB'}`);

    if (!existingSession) {
      return {
        sessionId: metadata.sessionId,
        status: 'new',
        dbMessageCount: 0,
        fileMessageCount: metadata.messageCount,
      };
    }

    // Get message count from database
    const messages = await messagesStore.list(existingSession.id);
    const dbMessageCount = messages.length;

    // Compare per-session timestamps rather than entry counts. The 2.1.x JSONL
    // emits non-conversational entries (attachments, queue-operations, etc.)
    // that we deliberately skip during sync, so message counts will not match
    // between DB and file even when fully up-to-date.
    const fileUpdatedAt = metadata.updatedAt;
    const dbUpdatedAt = existingSession.updatedAt ?? 0;
    const TOLERANCE_MS = 1000;

    if (fileUpdatedAt <= dbUpdatedAt + TOLERANCE_MS) {
      return {
        sessionId: metadata.sessionId,
        status: 'up-to-date',
        dbMessageCount,
        fileMessageCount: metadata.messageCount,
      };
    }

    return {
      sessionId: metadata.sessionId,
      status: 'needs-update',
      dbMessageCount,
      fileMessageCount: metadata.messageCount,
    };
  } catch (error) {
    log.error(`Failed to check sync status for ${metadata.sessionId}:`, error);
    throw error;
  }
}

/**
 * Synchronize a single session to the database
 */
export async function syncSession(
  sessionStore: SessionStore,
  messagesStore: AgentMessagesStore,
  metadata: SessionMetadata
): Promise<SyncResult> {
  try {
    log.info(`Syncing session ${metadata.sessionId}...`);

    // Get session file path
    const filePath = getSessionFilePath(metadata.workspacePath, metadata.sessionId);

    // Parse session file
    const entries = await parseSessionFile(filePath);

    // Inline any externalised tool-result payloads (Claude Code 2.1.x stores
    // large tool outputs in <sessionId>/tool-results/ and references them
    // via <persisted-output> markers in the JSONL).
    if (metadata.hasExternalToolResults) {
      await Promise.all(entries.map(inlinePersistedOutputs));
    }

    // Read any subagent sidecar JSONLs. Each one becomes a stream of raw
    // messages on the parent session, tagged with `parent_tool_use_id` so
    // the canonical parser routes them under the existing subagent_id path.
    const subagentSidecars = metadata.hasSubagents
      ? await readSubagentSidecars(metadata.workspacePath, metadata.sessionId)
      : [];
    if (subagentSidecars.length > 0) {
      log.debug(
        `Session ${metadata.sessionId}: loaded ${subagentSidecars.length} subagent sidecar JSONL(s)`,
      );
      // Inline persisted-output markers in subagent entries too.
      if (metadata.hasExternalToolResults) {
        for (const sidecar of subagentSidecars) {
          await Promise.all(sidecar.entries.map(inlinePersistedOutputs));
        }
      }
    }

    // Check if session exists
    const existingSession = await sessionStore.get(metadata.sessionId);
    const existingMessages = existingSession ? await messagesStore.list(metadata.sessionId) : [];
    const skipCount = existingMessages.length;

    // Create or update session
    if (!existingSession) {
      await sessionStore.create({
        id: metadata.sessionId,
        workspaceId: metadata.workspacePath,
        provider: 'claude-code',
        // Label the imported session with the model actually used (read from the
        // per-turn model on the JSONL assistant entries), falling back to the
        // real claude-code default rather than the renderer's hardcoded Sonnet (#394).
        model: importedClaudeCodeModel(entries) ?? DEFAULT_MODELS['claude-code'],
        title: metadata.title || 'Imported Session',
        sessionType: 'session',
        providerSessionId: metadata.sessionId, // CRITICAL: Pass the Claude Code session ID so SDK can resume
        providerConfig: {
          imported: true,
          importedAt: Date.now(),
          tokenUsage: metadata.tokenUsage,
        },
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
      });
      log.info(`Created new session ${metadata.sessionId} with token usage: ${metadata.tokenUsage.totalTokens} total`);
    } else {
      // Merge token usage into existing metadata
      const existingMetadata = existingSession.metadata || {};
      await sessionStore.updateMetadata(metadata.sessionId, {
        title: metadata.title || existingSession.title,
        metadata: {
          ...existingMetadata,
          tokenUsage: metadata.tokenUsage,
        },
      });
      log.info(`Updated session ${metadata.sessionId} with token usage: ${metadata.tokenUsage.totalTokens} total`);
    }

    // Convert main-session entries plus subagent sidecar entries into raw
    // messages, then sort the merged set by timestamp so subagent activity
    // interleaves with the parent in the order it actually happened.
    const mainMessages = entries
      .map(entryToMessage)
      .filter((msg): msg is NonNullable<typeof msg> => msg !== null);

    const subagentMessages = buildSubagentMessages(subagentSidecars);

    const allMessages = [...mainMessages, ...subagentMessages].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    // Import messages (skip already imported ones)
    let messagesAdded = 0;
    const messagesToImport = allMessages.slice(skipCount);

    for (const message of messagesToImport) {
      await messagesStore.create({
        sessionId: metadata.sessionId,
        source: 'claude-code-import',
        direction: message.direction,
        content: message.content,
        metadata: message.metadata,
        createdAt: message.timestamp,
      });
      messagesAdded++;
    }

    log.info(`Synced session ${metadata.sessionId}: ${messagesAdded} messages added (${allMessages.length} total after filtering)`);

    return {
      sessionId: metadata.sessionId,
      success: true,
      messagesAdded,
    };
  } catch (error) {
    log.error(`Failed to sync session ${metadata.sessionId}:`, error);
    return {
      sessionId: metadata.sessionId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      messagesAdded: 0,
    };
  }
}

/**
 * Batch sync multiple sessions
 */
export async function syncSessions(
  sessionStore: SessionStore,
  messagesStore: AgentMessagesStore,
  sessions: SessionMetadata[],
  progressCallback?: (current: number, total: number, sessionId: string) => void
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];

    if (progressCallback) {
      progressCallback(i + 1, sessions.length, session.sessionId);
    }

    const result = await syncSession(sessionStore, messagesStore, session);
    results.push(result);
  }

  return results;
}
