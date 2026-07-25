/**
 * Service to scan and import Claude Code sessions from ~/.claude/projects/
 *
 * This service discovers sessions created by the Claude Code CLI or other tools
 * and synchronizes them with Nimbalyst's database.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger';
import type { TokenUsageCategory } from '@nimbalyst/runtime/ai/server/types';
import { resolveClaudeConfigDir } from '@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir';

const log = logger.aiSession;

export interface SessionMetadata {
  sessionId: string;
  workspacePath: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalTokens: number;
    categories?: TokenUsageCategory[];
  };
  firstMessage: string | null;
  hasErrors: boolean;
  /** Whether the session has an `<sessionId>/subagents/` sidecar dir. */
  hasSubagents: boolean;
  /** Whether the session has an `<sessionId>/tool-results/` sidecar dir. */
  hasExternalToolResults: boolean;
  /** CLI-side codename like "agile-cooking-gosling" (Claude Code 2.1.x). */
  slug: string | null;
}

/**
 * Entry types in a Claude Code JSONL file.
 *
 * Conversational entries (`user`, `assistant`) carry a `message` object.
 * Several non-conversational entry types ride alongside them:
 *
 * - `attachment` -- mid-session context delta (tools added, MCP instructions,
 *   skill listing). Carries an `attachment` object instead of a `message`.
 * - `last-prompt` -- rolling bookmark of the most recent user prompt.
 * - `queue-operation` -- internal SDK enqueue/dequeue tracking.
 * - `file-history-snapshot` -- AI file-edit snapshots.
 * - `summary` -- LLM-generated session summary (legacy title source).
 * - `system` -- system messages from the CLI.
 */
export type ClaudeCodeEntryType =
  | 'user'
  | 'assistant'
  | 'summary'
  | 'system'
  | 'attachment'
  | 'last-prompt'
  | 'queue-operation'
  | 'file-history-snapshot';

export interface ClaudeCodeMessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** New in Claude Code 2.1.x. */
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
  };
  service_tier?: string;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  inference_geo?: string;
  iterations?: any[];
  speed?: string;
}

export interface ClaudeCodeMessage {
  id?: string;
  role?: string;
  content?: any;
  /** Per-turn model id (e.g. "claude-opus-4-7"). New in 2.1.x. */
  model?: string;
  stop_reason?: string;
  stop_sequence?: string | null;
  stop_details?: any;
  usage?: ClaudeCodeMessageUsage;
}

export interface ClaudeCodeAttachment {
  type: 'deferred_tools_delta' | 'mcp_instructions_delta' | 'skill_listing' | string;
  addedNames?: string[];
  removedNames?: string[];
  addedBlocks?: string[];
  content?: string;
  [key: string]: any;
}

export interface ClaudeCodeEntry {
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  type: ClaudeCodeEntryType;
  message?: ClaudeCodeMessage;
  /** True for entries belonging to subagent JSONL files. */
  isSidechain?: boolean;
  /** Mid-session context delta (only on `type: 'attachment'`). */
  attachment?: ClaudeCodeAttachment;
  /** Most recent user prompt (only on `type: 'last-prompt'`). */
  lastPrompt?: string;
  /** SDK queue-operation kind (only on `type: 'queue-operation'`). */
  operation?: 'enqueue' | 'dequeue' | string;
  /** Tool-result payload that supplements `message.content` tool_result blocks. */
  toolUseResult?: any;
  /** Subagent id (only on entries inside `subagents/agent-<id>.jsonl`). */
  agentId?: string;
  /** Prompt id (only on subagent entries). */
  promptId?: string;
  /** Origin: "external", "internal", etc. */
  userType?: string;
  /** SDK entrypoint: "sdk-ts", "cli", etc. */
  entrypoint?: string;
  /** SDK request id on assistant messages. */
  requestId?: string;
  /** Links a tool-result entry back to the assistant turn that produced it. */
  sourceToolAssistantUUID?: string;
  /** Human-readable session codename. */
  slug?: string;
  /** LLM-generated session title (preferred over legacy `summary` entries). */
  aiTitle?: string;
  /** Used by `file-history-snapshot` entries. */
  snapshot?: any;
  isSnapshotUpdate?: boolean;
  messageId?: string;
  /** Marks a message as a meta entry (command output, caveat). */
  isMeta?: boolean;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  [key: string]: any;
}

/**
 * Encode an absolute workspace path the same way Claude Code does when
 * choosing a directory under `~/.claude/projects/`.
 *
 * Claude Code replaces every non-ASCII-alphanumeric character with `-` (see
 * `@anthropic-ai/claude-code/cli.js`: `A.replace(/[^a-zA-Z0-9]/g, "-")`).
 * That means slashes, spaces, apostrophes, dots, underscores, and accented
 * letters all collapse to dashes. We must match that exactly or the
 * workspace-filtered scan will silently return zero sessions for any path
 * containing such characters (e.g. `/Users/x/Test Project`,
 * `/Users/x/Lenny's Podcast`).
 */
export function encodeWorkspaceDir(workspacePath: string): string {
  return workspacePath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Normalize escaped workspace path to absolute path.
 *
 * NOTE: Claude Code's encoding is lossy (every non-alphanumeric becomes `-`),
 * so this inverse is best-effort -- a directory like `-Users-foo-my-repo`
 * could decode to `/Users/foo/my-repo` or `/Users/foo/my repo`. Prefer the
 * `cwd` field from the JSONL itself when available.
 */
export function normalizeWorkspacePath(escapedPath: string): string {
  // Remove leading dash and replace dashes with slashes
  const normalized = escapedPath.startsWith('-')
    ? escapedPath.slice(1).replace(/-/g, '/')
    : escapedPath.replace(/-/g, '/');

  // Add leading slash for absolute path
  return `/${normalized}`;
}

/**
 * Get the directory that holds Claude Code project sidecars.
 *
 * Defaults to `<claude config dir>/projects`, honoring CLAUDE_CONFIG_DIR.
 * Tests override the location by setting
 * `NIMBALYST_CLAUDE_PROJECTS_DIR` so they can run against a fixture
 * workspace instead of the user's real Claude Code data.
 */
function getClaudeProjectsDir(): string {
  const override = process.env.NIMBALYST_CLAUDE_PROJECTS_DIR;
  if (override) return override;
  return path.join(resolveClaudeConfigDir(), 'projects');
}

/**
 * Check if ~/.claude/projects directory exists
 */
export async function claudeProjectsDirExists(): Promise<boolean> {
  try {
    const projectsDir = getClaudeProjectsDir();
    const stats = await fs.stat(projectsDir);
    return stats.isDirectory();
  } catch (error) {
    return false;
  }
}

/**
 * Scan ~/.claude/projects/ and return list of workspace directories
 */
export async function scanWorkspaceDirectories(): Promise<string[]> {
  const projectsDir = getClaudeProjectsDir();

  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch (error) {
    log.error('Failed to scan workspace directories:', error);
    return [];
  }
}

/**
 * Get all session JSONL files in a workspace directory.
 *
 * Returns only top-level main-conversation JSONL files. Per-session sidecar
 * data (subagents, tool-results) lives in `<sessionId>/` subdirectories and
 * is loaded on-demand during sync, not during the metadata scan.
 */
async function getSessionFiles(workspaceDir: string): Promise<string[]> {
  const projectsDir = getClaudeProjectsDir();
  const fullPath = path.join(projectsDir, workspaceDir);

  try {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    return entries
      .filter(entry =>
        entry.isFile() &&
        entry.name.endsWith('.jsonl') &&
        // Legacy: pre-2.1 sidechain JSONLs lived next to the main log.
        // They are now in `<sessionId>/subagents/`, but keep the filter so
        // older project directories still scan cleanly.
        !entry.name.startsWith('agent-')
      )
      .map(entry => path.join(fullPath, entry.name));
  } catch (error) {
    log.error(`Failed to read session files in ${workspaceDir}:`, error);
    return [];
  }
}

/**
 * Check whether a session has the per-session sidecar directories used by
 * Claude Code 2.1.x for subagent transcripts and externalised tool results.
 */
async function probeSessionSidecar(
  workspaceDir: string,
  sessionId: string,
): Promise<{ hasSubagents: boolean; hasExternalToolResults: boolean }> {
  const projectsDir = getClaudeProjectsDir();
  const sidecarDir = path.join(projectsDir, workspaceDir, sessionId);

  const [hasSubagents, hasExternalToolResults] = await Promise.all([
    dirExists(path.join(sidecarDir, 'subagents')),
    dirExists(path.join(sidecarDir, 'tool-results')),
  ]);
  return { hasSubagents, hasExternalToolResults };
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Parse a single line of JSONL
 */
function parseJSONLLine(line: string): ClaudeCodeEntry | null {
  try {
    return JSON.parse(line);
  } catch (error) {
    return null;
  }
}

/**
 * Extract session metadata from a JSONL file without loading entire file
 */
export async function extractSessionMetadata(filePath: string): Promise<SessionMetadata | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    if (lines.length === 0) {
      log.warn(`Empty session file: ${filePath}`);
      return null;
    }

    let sessionId: string | null = null;
    let title: string | null = null;
    let aiTitle: string | null = null;
    let summaryTitle: string | null = null;
    let slug: string | null = null;
    let firstTimestamp: number | null = null;
    let lastTimestamp: number | null = null;
    let firstMessage: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationInputTokens = 0;
    let cacheReadInputTokens = 0;
    let hasErrors = false;
    let workspacePath: string | null = null;

    // Track unique message IDs to avoid counting streaming chunks multiple times
    const seenMessageIds = new Set<string>();

    // Parse entries
    for (const line of lines) {
      const entry = parseJSONLLine(line);
      if (!entry) {
        hasErrors = true;
        continue;
      }

      // Extract session ID
      if (!sessionId && entry.sessionId) {
        sessionId = entry.sessionId;
      }

      // Extract workspace path from cwd
      if (!workspacePath && entry.cwd) {
        workspacePath = entry.cwd;
      }

      // Extract timestamps
      if (entry.timestamp) {
        const timestamp = new Date(entry.timestamp).getTime();
        if (!isNaN(timestamp)) {
          if (firstTimestamp === null || timestamp < firstTimestamp) firstTimestamp = timestamp;
          if (lastTimestamp === null || timestamp > lastTimestamp) lastTimestamp = timestamp;
        }
      }

      // Capture slug (first occurrence wins; CLI 2.1.x sets it on every entry).
      if (!slug && typeof entry.slug === 'string' && entry.slug) {
        slug = entry.slug;
      }

      // Capture aiTitle when present -- the LLM-generated session title is
      // strictly preferred over the legacy `summary` entry.
      if (!aiTitle && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
        aiTitle = entry.aiTitle.trim();
      }

      // Legacy: parse `summary` entries as a fallback title source.
      if (entry.type === 'summary') {
        if ((entry as any).summary) {
          summaryTitle = (entry as any).summary;
        } else if (entry.message?.content) {
          const content = entry.message.content;
          if (typeof content === 'string' && content.includes('title:')) {
            const match = content.match(/title:\s*(.+?)(\n|$)/);
            if (match) {
              summaryTitle = match[1].trim();
            }
          }
        }
      }

      // Extract first user message (skip system messages and caveats)
      if (!firstMessage && entry.type === 'user' && entry.message?.content) {
        const content = entry.message.content;
        let text = '';

        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          // Handle multi-part content
          for (const part of content) {
            if (part.type === 'text' && part.text) {
              text = part.text;
              break;
            }
          }
        }

        // Skip system messages, caveats, slash commands, and command output
        const lowerText = text.toLowerCase();
        const trimmedText = text.trim();
        const isSystemMessage =
          lowerText.includes('caveat:') ||
          lowerText.includes('<nimbalyst_system_message>') ||
          lowerText.includes('<command-name>') ||
          lowerText.includes('<local-command-stdout>') ||
          lowerText.includes('<system-reminder>') ||
          lowerText.includes('the messages below were generated') ||
          trimmedText.startsWith('/');  // Skip slash commands like /clear, /context, etc.

        if (trimmedText && !isSystemMessage) {
          firstMessage = text.slice(0, 200);
        }
      }

      // Aggregate token usage - deduplicate by message ID to avoid counting streaming chunks
      // Each streamed response has multiple JSONL entries but the same message.id
      if (entry.type === 'assistant' && entry.message?.usage) {
        const messageId = entry.message.id || entry.uuid;

        // Only count tokens once per unique message
        if (messageId && !seenMessageIds.has(messageId)) {
          seenMessageIds.add(messageId);
          const usage = entry.message.usage;
          inputTokens += usage.input_tokens || 0;
          outputTokens += usage.output_tokens || 0;
          cacheCreationInputTokens += usage.cache_creation_input_tokens || 0;
          cacheReadInputTokens += usage.cache_read_input_tokens || 0;
        }
      }
    }

    // Title resolution priority: aiTitle (LLM-generated) > legacy `summary` entry > first-message fallback.
    if (aiTitle) {
      title = aiTitle;
    } else if (summaryTitle) {
      title = summaryTitle;
    }

    // Derive session ID from filename if not found in entries
    if (!sessionId) {
      const filename = path.basename(filePath, '.jsonl');
      sessionId = filename;
    }

    // Generate title if not found
    if (!title) {
      title = firstMessage ? firstMessage.slice(0, 50) + '...' : 'Untitled Session';
    }

    // Extract workspace path from file path if not found
    const projectsDir = getClaudeProjectsDir();
    const workspaceDir = path.basename(path.dirname(filePath));
    if (!workspacePath) {
      workspacePath = normalizeWorkspacePath(workspaceDir);
    }

    // Use current time as fallback only if no timestamps found
    const now = Date.now();
    const createdAt = firstTimestamp ?? now;
    const updatedAt = lastTimestamp ?? now;

    // Probe for the `<sessionId>/` sidecar dir without parsing its contents.
    const sidecar = await probeSessionSidecar(workspaceDir, sessionId);

    return {
      sessionId,
      workspacePath,
      title,
      createdAt,
      updatedAt,
      messageCount: lines.length,
      tokenUsage: {
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      firstMessage,
      hasErrors,
      hasSubagents: sidecar.hasSubagents,
      hasExternalToolResults: sidecar.hasExternalToolResults,
      slug,
    };
  } catch (error) {
    log.error(`Failed to extract metadata from ${filePath}:`, error);
    return null;
  }
}

/**
 * Workspace-level index file written by Claude Code 2.1.x.
 * Lives at `<projectsDir>/<workspaceDir>/sessions-index.json`.
 */
interface SessionsIndex {
  version: number;
  entries: SessionsIndexEntry[];
}

export interface SessionsIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

/**
 * Read the per-workspace `sessions-index.json` if Claude Code 2.1.x has
 * written one. Returns null when missing or unreadable so callers can fall
 * back to a full directory scan.
 */
export async function readSessionsIndex(
  workspaceDir: string,
): Promise<SessionsIndex | null> {
  const indexPath = path.join(getClaudeProjectsDir(), workspaceDir, 'sessions-index.json');
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(raw) as SessionsIndex;
    if (typeof parsed?.version !== 'number' || !Array.isArray(parsed.entries)) {
      log.warn(`sessions-index.json at ${indexPath} has unexpected shape`);
      return null;
    }
    return parsed;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      log.warn(`Failed to read sessions-index.json at ${indexPath}: ${error?.message ?? error}`);
    }
    return null;
  }
}

/**
 * Scan Claude Code sessions and return metadata
 *
 * Fast path: when the workspace has a `sessions-index.json` (Claude Code
 * 2.1.x), use it to enumerate session files and to filter out sidechain
 * sessions without opening each JSONL just to find out. Falls back to a
 * full directory listing for older installs.
 *
 * @param workspacePath - Optional workspace path to filter sessions. If provided, only scans that workspace.
 */
export async function scanAllSessions(workspacePath?: string): Promise<SessionMetadata[]> {
  let workspaceDirs: string[];

  if (workspacePath) {
    // Only scan the specified workspace. Mirror Claude Code's encoder so
    // paths containing spaces, apostrophes, dots, underscores, etc. resolve
    // to the same directory Claude Code wrote.
    const escapedPath = encodeWorkspaceDir(workspacePath);
    workspaceDirs = [escapedPath];
    log.info(`Scanning sessions for workspace: ${workspacePath} -> ${escapedPath}`);
  } else {
    // Scan all workspaces
    workspaceDirs = await scanWorkspaceDirectories();
    log.info(`Scanning sessions from all workspaces`);
  }

  const sessions: SessionMetadata[] = [];

  for (const workspaceDir of workspaceDirs) {
    const sessionFiles = await resolveSessionFiles(workspaceDir);

    for (const filePath of sessionFiles) {
      const metadata = await extractSessionMetadata(filePath);
      if (metadata) {
        sessions.push(metadata);
      }
    }
  }

  log.info(`Scanned ${sessions.length} sessions from ${workspaceDirs.length} workspace(s)`);
  return sessions;
}

/**
 * Enumerate session files for a workspace.
 *
 * The directory listing is the source of truth: the JSONL files that exist
 * on disk are exactly the sessions we can import. `sessions-index.json` --
 * when present -- is consulted only to filter out sidechain sessions
 * without opening every JSONL. The index can drift (we've seen real users
 * with 494 entries pointing at ~230 actual files), so we do not trust
 * `fullPath` entries to exist.
 */
async function resolveSessionFiles(workspaceDir: string): Promise<string[]> {
  const dirFiles = await getSessionFiles(workspaceDir);
  const index = await readSessionsIndex(workspaceDir);
  if (!index) return dirFiles;

  const sidechainIds = new Set(
    index.entries
      .filter(entry => entry.isSidechain === true && typeof entry.sessionId === 'string')
      .map(entry => entry.sessionId),
  );
  if (sidechainIds.size === 0) {
    log.debug(
      `sessions-index loaded: workspace=${workspaceDir} entries=${index.entries.length} (no sidechains to filter)`,
    );
    return dirFiles;
  }

  const filtered = dirFiles.filter(filePath => {
    const sessionId = path.basename(filePath, '.jsonl');
    return !sidechainIds.has(sessionId);
  });
  log.debug(
    `sessions-index sidechain filter: workspace=${workspaceDir} dirFiles=${dirFiles.length} sidechains=${sidechainIds.size} kept=${filtered.length}`,
  );
  return filtered;
}

