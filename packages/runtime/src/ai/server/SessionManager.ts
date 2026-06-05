/**
 * Session manager with injectable storage backend
 */

import { v4 as uuidv4 } from 'uuid';
import { AISessionsRepository } from '../../storage/repositories/AISessionsRepository';
import { AgentMessagesRepository } from '../../storage/repositories/AgentMessagesRepository';
import {
  getSessionStore,
  hasSessionStore,
  setSessionStore,
  type SessionStore,
  type SessionMeta,
  type UpdateSessionMetadataPayload,
} from '../adapters/sessionStore';
import {
  SessionData,
  Message,
  DocumentContext,
  AIProviderType,
  SessionType,
  ModelIdentifier,
  shouldBlockStartedSessionProviderSwitch,
  AgentRole,
} from './types';
import type { TranscriptViewMessage } from './transcript/TranscriptProjector';
import type { SessionData as ChatSession } from './types';
import { parseContextUsageMessage } from './utils/contextUsage';
import { TranscriptMigrationRepository } from '../../storage/repositories/TranscriptMigrationRepository';

/** Parsed tool_progress event from the agent stream */
interface ToolProgressEvent {
  type: 'tool_progress';
  parent_tool_use_id?: string;
  tool_name?: string;
  elapsed_time_seconds?: number;
}

/** Input arguments for a Task tool invocation */
interface TaskToolInput {
  subagent_type?: string;
  name?: string;
  team_name?: string;
  mode?: string;
  [key: string]: unknown;
}

function toTimestampMillis(value: unknown): number {
  if (!value) return Date.now();
  if (typeof value === 'number') return value;
  const dt = new Date(value as any);
  const time = dt.getTime();
  return Number.isNaN(time) ? Date.now() : time;
}

function isSystemReminderMessage(
  content: string,
  metadata?: Record<string, unknown>
): boolean {
  return metadata?.promptType === 'system_reminder' ||
    /<SYSTEM_REMINDER>[\s\S]*<\/SYSTEM_REMINDER>/.test(content);
}

function stripSystemReminderTags(content: string): string {
  return content
    .replace(/^\s*<SYSTEM_REMINDER>/, '')
    .replace(/<\/SYSTEM_REMINDER>\s*$/, '')
    .trim();
}

function normalizeStoredModelIdentifier(
  provider: string | null | undefined,
  model: string | undefined
): string | undefined {
  if (!model) {
    return model;
  }

  if (provider === 'claude-code' || model.startsWith('claude-code:')) {
    const parsed = ModelIdentifier.parse(model);
    if (provider === 'claude-code' && parsed.provider !== 'claude-code') {
      throw new Error(`Claude Agent sessions require a claude-code:* model identifier. Received: ${model}`);
    }
    return parsed.combined;
  }

  return model;
}

// Separate ID counter for server-message view models. Starts far from the
// optimistic counter range (-1, -2, ...) used in the renderer to avoid collisions.
let serverMsgIdCounter = -1_000_000;
function nextServerMsgId(): number {
  return serverMsgIdCounter--;
}

/**
 * Convert a raw server/provider message into a TranscriptViewMessage
 * for in-memory session state. Used by the legacy addMessage path.
 */
function viewMessageFromServerMessage(msg: any): TranscriptViewMessage {
  const roleToType: Record<string, TranscriptViewMessage['type']> = {
    user: 'user_message',
    assistant: 'assistant_message',
    system: 'system_message',
    tool: 'tool_call',
  };
  const type = roleToType[msg.role] ?? 'assistant_message';

  const vm: TranscriptViewMessage = {
    id: nextServerMsgId(),
    sequence: -1,
    createdAt: new Date(msg.timestamp || Date.now()),
    type,
    text: msg.content ?? msg.errorMessage ?? '',
    mode: msg.mode,
    subagentId: null,
    isError: msg.isError,
    isAuthError: msg.isAuthError,
    metadata: msg.metadata,
    attachments: msg.attachments,
  };

  if (msg.toolCall) {
    const tc = msg.toolCall;
    vm.toolCall = {
      toolName: tc.name ?? tc.toolName ?? '',
      toolDisplayName: tc.name ?? tc.toolName ?? '',
      status: tc.isError ? 'error' : 'completed',
      description: tc.description ?? null,
      arguments: tc.arguments ?? {},
      targetFilePath: tc.targetFilePath ?? null,
      mcpServer: null,
      mcpTool: null,
      result: typeof tc.result === 'string' ? tc.result : tc.result != null ? JSON.stringify(tc.result) : undefined,
      isError: tc.isError,
      providerToolCallId: tc.id ?? null,
      progress: [],
    };
  }

  return vm;
}

function sessionDataFromChatSession(session: ChatSession, fallbackWorkspace: string): SessionData {
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const documentContext = metadata.documentContext as DocumentContext | undefined;
  const workspaceId = (metadata.workspaceId as string | undefined) ?? fallbackWorkspace;
  const providerConfig = metadata.providerConfig as SessionData['providerConfig'];
  // CRITICAL: providerSessionId is stored at top-level, not in metadata
  const providerSessionId = session.providerSessionId ?? (metadata.providerSessionId as string | undefined);

  // Read tokenUsage from metadata if present
  const tokenUsage = metadata.tokenUsage as SessionData['tokenUsage'] | undefined;

  return {
    id: session.id,
    provider: session.provider as AIProviderType,
    model: session.model ?? undefined,
    sessionType: session.sessionType,
    mode: session.mode,
    agentRole: session.agentRole ?? 'standard',
    createdBySessionId: session.createdBySessionId ?? null,
    createdAt: toTimestampMillis(session.createdAt),
    updatedAt: toTimestampMillis(session.updatedAt),
    messages: session.messages.map(viewMessageFromServerMessage),
    documentContext,
    workspacePath: workspaceId,
    title: session.title ?? 'New conversation',
    draftInput: session.draftInput ?? undefined,
    providerConfig,
    providerSessionId,
    lastReadMessageTimestamp: session.lastReadMessageTimestamp ?? undefined,
    tokenUsage,
    metadata: session.metadata ?? {},
    isArchived: session.isArchived ?? false,
    // Worktree fields - passed through from database query
    worktreeId: session.worktreeId ?? undefined,
    worktreePath: session.worktreePath ?? undefined,
    // Hierarchical workstream parent (separate from branch)
    parentSessionId: session.parentSessionId ?? undefined,
    // Branch tracking fields - passed through from database query
    branchedFromSessionId: session.branchedFromSessionId ?? undefined,
    branchPointMessageId: session.branchPointMessageId ?? undefined,
    branchedAt: session.branchedAt ?? undefined,
    branchedFromProviderSessionId: session.branchedFromProviderSessionId ?? undefined,
  } satisfies SessionData;
}

/**
 * Transform raw agent messages from database into UI-friendly format
 * This processes the raw input/output logs and reconstructs the conversation
 * Implements three-pass processing for sub-agent support:
 * 1. Build parent-child map from parent_tool_use_id
 * 2. Create all tool messages with sub-agent metadata
 * 3. Build hierarchy and filter out child tools from top-level
 */
export function transformAgentMessagesToUI(agentMessages: any[]): Message[] {
  const uiMessages: Message[] = [];
  const allToolMessages = new Map<string, Message>(); // Map tool ID -> Message
  const parentToolMap = new Map<string, string>(); // Map child tool ID -> parent tool ID
  const teammateParentMap = new Map<string, string>(); // agentId -> parent tool_use_id

  // PASS 1: Build parent-child relationship map
  for (const agentMsg of agentMessages) {
    try {
      if (agentMsg.direction === 'output') {
        try {
          const parsed = JSON.parse(agentMsg.content);

          // Check for parent_tool_use_id which indicates this message contains sub-agent tools
          if (parsed.parent_tool_use_id && parsed.message?.content) {
            const parentToolId = parsed.parent_tool_use_id;
            const content = parsed.message.content;

            // Map all tool_use blocks in this message to the parent
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_use' && block.id) {
                  parentToolMap.set(block.id, parentToolId);
                }
              }
            }
          }

          // Build teammate -> parent Task mapping from synthetic teammate_spawned results
          if (parsed.type === 'user' && parsed.message?.content) {
            const content = parsed.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_result' && block.content) {
                  try {
                    const resultContent = typeof block.content === 'string'
                      ? JSON.parse(block.content)
                      : block.content;
                    if ((resultContent.status === 'teammate_spawned' || resultContent.status === 'background_agent_spawned' || resultContent.status === 'subagent_spawned') && resultContent.agent_id && block.tool_use_id) {
                      teammateParentMap.set(resultContent.agent_id, block.tool_use_id);
                    }
                  } catch { /* not JSON */ }
                }
              }
            }
          }
        } catch (parseError) {
          // Not JSON or doesn't have the structure we're looking for
        }
      }
    } catch (error) {
      // Continue processing other messages
    }
  }

  // PASS 2: Process messages in order and create tool messages
  for (const agentMsg of agentMessages) {
    // Skip hidden messages - they shouldn't appear in UI
    if (agentMsg.hidden) {
      continue;
    }

    const timestamp = agentMsg.createdAt ? new Date(agentMsg.createdAt).getTime() : Date.now();

    try {
      // Handle different message types based on direction and content
      if (agentMsg.direction === 'input') {
        // Try to parse as JSON first (Claude Code format)
        try {
          const parsed = JSON.parse(agentMsg.content);
          if (parsed.prompt) {
            // Claude Code format: { prompt: "...", options: {...} }
            // Extract attachments and mode from metadata if present
            const attachments = agentMsg.metadata?.attachments;
            const mode = agentMsg.metadata?.mode;

            // Skip system continuation messages (should be hidden in DB, but safety net)
            // These are auto-generated prompts like "[System: Your previous turn ended...]"
            if (parsed.prompt.startsWith('[System:')) {
              continue;
            }

            // Detect teammate messages via DB metadata (Path 1: mid-turn injection)
            // or content pattern (Path 2: idle sendMessage, backward compat)
            // Batched messages use "---" separator between multiple [Teammate message from "..."] blocks
            const isTeammateFromMetadata = agentMsg.metadata?.messageType === 'teammate_message_injected';
            const teammateContentMatch = parsed.prompt.match(/^\[Teammate message from "([^"]+)"\]\n\n/);
            const isTeammateMessage = isTeammateFromMetadata || !!teammateContentMatch;

            if (isTeammateMessage) {
              // Split batched teammate messages (separated by \n\n---\n\n)
              const segments = parsed.prompt.split(/\n\n---\n\n/);
              for (const segment of segments) {
                const segmentMatch = segment.match(/^\[Teammate message from "([^"]+)"\]\n\n([\s\S]*)$/);
                const teammateName = segmentMatch?.[1] || agentMsg.metadata?.teammateName || 'Unknown';
                const cleanContent = segmentMatch ? segmentMatch[2] : segment;
                uiMessages.push({
                  role: 'user',
                  content: cleanContent,
                  timestamp,
                  mode,
                  isUserInput: false,
                  metadata: { isTeammateMessage: true, teammateName },
                });
              }
            } else {
              const isSystemReminder = isSystemReminderMessage(parsed.prompt, agentMsg.metadata);
              uiMessages.push({
                role: isSystemReminder ? 'system' : 'user',
                content: isSystemReminder ? stripSystemReminderTags(parsed.prompt) : parsed.prompt,
                timestamp,
                mode,
                isUserInput: !isSystemReminder,
                isSystem: isSystemReminder || undefined,
                attachments: attachments && attachments.length > 0 ? attachments : undefined,
                metadata: agentMsg.metadata,
              });
            }
          } else if (parsed.type === 'user' && parsed.message) {
            // Slash command format: { type: "user", message: { role: "user", content: "..." } }
            const msg = parsed.message;

            // Check if this is a tool result message (content is array with tool_result blocks)
            if (Array.isArray(msg.content) && msg.content.some((block: any) => block.type === 'tool_result')) {
              // This is a tool result - find the corresponding tool_use and add the result
              for (const block of msg.content) {
                if (block.type === 'tool_result') {
                  const toolUseId = block.tool_use_id;
                  let resultText = '';

                  if (Array.isArray(block.content)) {
                    for (const innerBlock of block.content) {
                      if (innerBlock.type === 'text' && innerBlock.text) {
                        resultText += innerBlock.text;
                      }
                    }
                  }

                  // Search backwards for the tool message with this ID
                  for (let i = uiMessages.length - 1; i >= 0; i--) {
                    const uiMsg = uiMessages[i];
                    if (uiMsg.role === 'tool' && uiMsg.toolCall && uiMsg.toolCall.id === toolUseId) {
                      // Add the result to this tool call
                      uiMsg.toolCall.result = resultText;
                      break;
                    }
                  }
                }
              }
            } else {
              // Regular user message with string content
              let content = typeof msg.content === 'string' ? msg.content : '';
              const isSystemReminder = isSystemReminderMessage(content, agentMsg.metadata);

              // Extract attachments from metadata if present
              const attachments = agentMsg.metadata?.attachments;
              uiMessages.push({
                role: isSystemReminder ? 'system' : (msg.role || 'user'),
                content: isSystemReminder ? stripSystemReminderTags(content) : content,
                timestamp,
                isUserInput: !isSystemReminder,
                isSystem: isSystemReminder || undefined,
                attachments: attachments && attachments.length > 0 ? attachments : undefined,
                metadata: agentMsg.metadata,
              });
            }
          }
        } catch (parseError) {
          // Not JSON - treat as raw text (regular Claude SDK format)
          // Extract attachments from metadata if present
          const attachments = agentMsg.metadata?.attachments;
          const content = String(agentMsg.content ?? '');
          const isSystemReminder = isSystemReminderMessage(content, agentMsg.metadata);
          uiMessages.push({
            role: isSystemReminder ? 'system' : 'user',
            content: isSystemReminder ? stripSystemReminderTags(content) : content,
            attachments: attachments && attachments.length > 0 ? attachments : undefined,
            isUserInput: !isSystemReminder,
            isSystem: isSystemReminder || undefined,
            timestamp,
            metadata: agentMsg.metadata,
          });
        }
      } else if (agentMsg.direction === 'output') {
        // CODEX RAW EVENTS: Store raw Codex SDK events with metadata for display-time parsing
        if (agentMsg.metadata?.codexProvider === true && agentMsg.metadata?.eventType) {
          uiMessages.push({
            role: 'assistant',
            content: agentMsg.content,
            timestamp,
            metadata: agentMsg.metadata,
          });
          continue;
        }

        // Try to parse as JSON
        try {
          const parsed = JSON.parse(agentMsg.content);

          // MANAGED TEAMMATE OUTPUT: Link teammate tool calls to parent Task card
          if (parsed._isTeammateOutput && parsed._teammateAgentId) {
            const teammateAgentId = parsed._teammateAgentId;

            if (parsed.message?.content && Array.isArray(parsed.message.content)) {
              for (const block of parsed.message.content) {
                if (block.type === 'tool_use' && block.id) {
                  const parentTaskId = teammateParentMap.get(teammateAgentId);
                  if (parentTaskId) {
                    parentToolMap.set(block.id, parentTaskId);
                  }
                }
              }
            }
            // Continue processing -- normal tool_use/tool_result handling will
            // create the tool messages and link them via parentToolMap
          }

          // Track whether this chunk is teammate/background agent output
          // so we can skip text blocks from the main stream
          const isTeammateOutput = !!(parsed._isTeammateOutput && parsed._teammateAgentId);

          if (parsed.type === 'text' && parsed.content !== undefined) {
            // Skip teammate/background agent text - stays inside parent Task card
            if (!isTeammateOutput) {
              // Claude Code text chunk: { type: 'text', content: '...' }
              const lastMsg = uiMessages[uiMessages.length - 1];
              if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.isComplete) {
                lastMsg.content += parsed.content;
              } else {
                uiMessages.push({
                  role: 'assistant',
                  content: parsed.content,
                  timestamp
                });
              }
            }
          } else if (parsed.type === 'assistant' && parsed.message) {
            // Full assistant message with structured content
            if (Array.isArray(parsed.message.content)) {
              for (const block of parsed.message.content) {
                if (block.type === 'text') {
                  // Skip teammate/background agent text - stays inside parent Task card
                  if (!isTeammateOutput) {
                    const lastMsg = uiMessages[uiMessages.length - 1];
                    if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.isComplete) {
                      lastMsg.content += block.text || '';
                    } else {
                      uiMessages.push({
                        role: 'assistant',
                        content: block.text || '',
                        timestamp
                      });
                    }
                  }
                } else if (block.type === 'tool_use') {
                  // Tool call - create tool message with sub-agent metadata
                  // Skip if we already have a tool with this ID (deduplication)
                  if (block.id && allToolMessages.has(block.id)) {
                    continue;
                  }

                  const isTaskAgent = block.name === 'Task' || block.name === 'Agent';
                  const parentToolId = parentToolMap.get(block.id);
                  const taskInput = (block.input || block.arguments) as TaskToolInput | undefined;

                  const toolMessage: Message = {
                    role: 'tool',
                    content: '',
                    timestamp,
                    toolCall: {
                      id: block.id,
                      name: block.name,
                      arguments: taskInput,
                      isSubAgent: isTaskAgent,
                      subAgentType: isTaskAgent ? String(taskInput?.subagent_type || '') : undefined,
                      parentToolId: parentToolId,
                      childToolCalls: [],
                      // Agent team teammate metadata
                      teammateName: isTaskAgent ? (taskInput?.name || undefined) : undefined,
                      teamName: isTaskAgent ? (taskInput?.team_name || undefined) : undefined,
                      teammateMode: isTaskAgent ? (taskInput?.mode || undefined) : undefined,
                      teammateAgentId: isTaskAgent && taskInput?.name && taskInput?.team_name
                        ? `${taskInput.name}@${taskInput.team_name}` : undefined,
                      teammateColor: isTaskAgent && taskInput?.team_name ? 'blue' : undefined,
                    }
                  };

                  // Store in allToolMessages map for hierarchy building
                  if (block.id) {
                    allToolMessages.set(block.id, toolMessage);
                  }

                  // Add child tools to their parent's childToolCalls array immediately (streaming)
                  if (parentToolId) {
                    const parentMessage = allToolMessages.get(parentToolId);
                    if (parentMessage && parentMessage.toolCall?.childToolCalls) {
                      parentMessage.toolCall.childToolCalls.push(toolMessage);
                    }
                  } else {
                    // Only add to uiMessages if it's a top-level tool (no parent)
                    uiMessages.push(toolMessage);
                  }
                } else if (block.type === 'tool_result') {
                  // Tool result - find the corresponding tool_use message and add result
                  const toolUseId = block.tool_use_id || block.id;

                  // Look up the tool message in our map
                  const toolMsg = allToolMessages.get(toolUseId);
                  if (toolMsg && toolMsg.toolCall) {
                    toolMsg.toolCall.result = block.content;
                    if (block.is_error) {
                      toolMsg.isError = true;
                    }
                  } else {
                    // Fallback: search backwards in uiMessages (for backward compatibility)
                    for (let i = uiMessages.length - 1; i >= 0; i--) {
                      const msg = uiMessages[i];
                      if (msg.role === 'tool' && msg.toolCall && msg.toolCall.id === toolUseId) {
                        msg.toolCall.result = block.content;
                        if (block.is_error) {
                          msg.isError = true;
                        }
                        break;
                      }
                    }
                  }
                }
              }
            }
          } else if (parsed.type === 'error' && parsed.error) {
            // Error message from SDK or API
            const errorContent = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
            // Check for isAuthError from both parsed content and metadata
            const isAuthError = parsed.is_auth_error === true || agentMsg.metadata?.isAuthError === true;
            uiMessages.push({
              role: 'assistant',
              content: errorContent,
              timestamp,
              isError: true,
              isAuthError,
              errorMessage: errorContent
            });
          } else if (parsed.type === 'nimbalyst_tool_use') {
            // Nimbalyst-specific tool call (e.g., AskUserQuestion, ToolPermission)
            // These are our own tool calls that won't conflict with SDK messages
            // Skip if we already have a tool with this ID (deduplication)
            if (parsed.id && allToolMessages.has(parsed.id)) {
              continue;
            }

            const toolMessage: Message = {
              role: 'tool',
              content: '',
              timestamp,
              toolCall: {
                id: parsed.id,
                name: parsed.name,
                arguments: parsed.input,
                childToolCalls: []
              }
            };

            // Store in allToolMessages map for result matching
            if (parsed.id) {
              allToolMessages.set(parsed.id, toolMessage);
            }

            uiMessages.push(toolMessage);
          } else if (parsed.type === 'nimbalyst_tool_result') {
            // Nimbalyst-specific tool result - find corresponding nimbalyst_tool_use and add result
            const toolUseId = parsed.tool_use_id || parsed.id;
            const toolMsg = allToolMessages.get(toolUseId);
            if (toolMsg && toolMsg.toolCall) {
              toolMsg.toolCall.result = parsed.result;
              if (parsed.is_error) {
                toolMsg.isError = true;
              }
            }
          } else if (parsed.type === 'git_commit_proposal_response' && parsed.proposalId) {
            // Git commit proposal response (source=nimbalyst) - match to the tool call
            // by proposalId (which equals the tool_use ID). This handles the case where
            // the Claude Code SDK doesn't emit a tool_result (e.g., session ended after commit).
            // "committed" takes priority over "cancelled" for duplicate responses.
            const toolMsg = allToolMessages.get(parsed.proposalId);
            if (toolMsg && toolMsg.toolCall) {
              const existingResult = toolMsg.toolCall.result;
              const existingIsCommitted = existingResult && typeof existingResult === 'object'
                && (existingResult as any).action === 'committed';
              // Only set result if no existing result, or the new one is "committed" (overrides cancelled)
              if (!existingResult || (!existingIsCommitted && parsed.action === 'committed')) {
                toolMsg.toolCall.result = {
                  success: parsed.action === 'committed',
                  result: {
                    action: parsed.action,
                    commitHash: parsed.commitHash,
                    commitDate: parsed.commitDate,
                    error: parsed.error,
                    filesCommitted: parsed.filesCommitted,
                    commitMessage: parsed.commitMessage,
                  },
                };
              }
            }
          } else if (parsed.type === 'user' && parsed.message) {
            // Skip messages that have parent_tool_use_id - these are sub-agent metadata, not conversation messages
            if (parsed.parent_tool_use_id) {
              // This message is metadata for organizing sub-agent tools, skip it
              continue;
            }

            // Slash command format (output): { type: "user", message: { role: "user", content: "..." } }
            // Note: Sometimes slash command outputs are marked as "user" messages (e.g., local command stdout)
            const msg = parsed.message;

            // Check if this is a tool result message (content is array with tool_result blocks)
            if (Array.isArray(msg.content) && msg.content.some((block: any) => block.type === 'tool_result')) {
              // This is a tool result - find the corresponding tool_use and add the result
              for (const block of msg.content) {
                if (block.type === 'tool_result') {
                  const toolUseId = block.tool_use_id;
                  let resultText = '';

                  if (Array.isArray(block.content)) {
                    for (const innerBlock of block.content) {
                      if (innerBlock.type === 'text' && innerBlock.text) {
                        resultText += innerBlock.text;
                      }
                    }
                  }

                  // Search backwards for the tool message with this ID
                  for (let i = uiMessages.length - 1; i >= 0; i--) {
                    const uiMsg = uiMessages[i];
                    if (uiMsg.role === 'tool' && uiMsg.toolCall && uiMsg.toolCall.id === toolUseId) {
                      // Add the result to this tool call
                      uiMsg.toolCall.result = resultText;
                      break;
                    }
                  }
                }
              }
            } else {
              // Regular user/system message with string content
              let content = typeof msg.content === 'string' ? msg.content : '';

              // Extract content from <local-command-stdout> tags if present
              const stdoutMatch = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
              if (stdoutMatch && stdoutMatch[1]) {
                // Format as code block for command output with system response label
                content = '**System Response:**\n\n```\n' + stdoutMatch[1].trim() + '\n```';
              }

              uiMessages.push({
                role: msg.role || 'user',
                content: content,
                timestamp,
                isUserInput: false,
              });
            }
          } else if (parsed.type === 'tool_progress') {
            // Tool progress update - attach to parent tool to show activity
            const progress = parsed as ToolProgressEvent;
            const parentId = progress.parent_tool_use_id;
            if (parentId) {
              const parentMsg = allToolMessages.get(parentId);
              if (parentMsg && parentMsg.toolCall) {
                parentMsg.toolCall.toolProgress = {
                  toolName: progress.tool_name || 'unknown',
                  elapsedSeconds: progress.elapsed_time_seconds || 0,
                };
              }
            }
          } else if (parsed.type === 'result' && parsed.result && typeof parsed.result === 'string' && parsed.result.trim().length > 0) {
            // SDK result chunk -- contains the final text of the turn.
            // For normal agent responses, text was already accumulated from individual text chunks.
            // The result chunk duplicates that same text as the final assembled response.
            // Only render the result text if no text has been accumulated yet (slash command errors, etc.).
            const lastMsg = uiMessages[uiMessages.length - 1];
            const hasAccumulatedContent = lastMsg && lastMsg.role === 'assistant' && lastMsg.content.trim().length > 0;
            if (!hasAccumulatedContent) {
              // No text accumulated yet - this is a standalone result (e.g. slash command error)
              if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.isComplete) {
                lastMsg.content = parsed.result;
              } else {
                uiMessages.push({
                  role: 'assistant',
                  content: parsed.result,
                  timestamp,
                  isSystem: true,
                });
              }
            }
            // Always mark as complete since result is the final chunk
            const msg = uiMessages[uiMessages.length - 1];
            if (msg && msg.role === 'assistant') {
              msg.isComplete = true;
            }
          } else if (parsed.usage) {
            // This is metadata (usage stats), mark last message as complete
            const lastMsg = uiMessages[uiMessages.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.isComplete = true;
            }
          }
        } catch (parseError) {
          // Not valid JSON - treat as raw text output (regular Claude SDK)
          // This is the final output from ClaudeProvider.logAgentMessage()
          const content = agentMsg.content;
          if (content && content.trim()) {
            const lastMsg = uiMessages[uiMessages.length - 1];
            if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.isComplete) {
              // Shouldn't happen with Claude SDK (logs complete messages), but handle it
              lastMsg.content += content;
              lastMsg.isComplete = true;
            } else {
              // Create new complete assistant message
              uiMessages.push({
                role: 'assistant',
                content: content,
                timestamp
              });
              uiMessages[uiMessages.length - 1].isComplete = true;
            }
          }
        }
      }
    } catch (error) {
      console.warn('[SessionManager] Failed to process agent message:', error);
    }
  }

  // Mark the last message as complete if it's an assistant message and not already marked
  if (uiMessages.length > 0 && uiMessages[uiMessages.length - 1].role === 'assistant') {
    uiMessages[uiMessages.length - 1].isComplete = true;
  }

  // PASS 3: Build parent-child hierarchy (safety fallback)
  // NOTE: Hierarchy is now built incrementally during streaming (PASS 2), so this
  // should only catch edge cases where a child was created before its parent.
  // We keep this for robustness.
  for (const toolMessage of allToolMessages.values()) {
    if (toolMessage.toolCall?.parentToolId) {
      const parentMessage = allToolMessages.get(toolMessage.toolCall.parentToolId);
      if (parentMessage && parentMessage.toolCall?.childToolCalls) {
        // Check if not already added during streaming
        const alreadyAdded = parentMessage.toolCall.childToolCalls.some(
          child => child.toolCall?.id === toolMessage.toolCall?.id
        );
        if (!alreadyAdded) {
          parentMessage.toolCall.childToolCalls.push(toolMessage);
        }
      }
    }
  }

  return uiMessages;
}

/**
 * Transform raw agent messages from database into TranscriptViewMessage[] format.
 * Wraps transformAgentMessagesToUI, converting the legacy Message[] output.
 * Used by iOS transcript which doesn't have access to the canonical transcript pipeline.
 */
export function transformAgentMessagesToViewMessages(agentMessages: any[]): TranscriptViewMessage[] {
  const legacyMessages = transformAgentMessagesToUI(agentMessages);
  return legacyMessages.map(viewMessageFromServerMessage);
}

async function fetchSessionsForWorkspace(workspace: string): Promise<SessionData[]> {
  const items = await AISessionsRepository.list(workspace);
  const sessions = await Promise.all(
    items.map(async item => {
      const session = await AISessionsRepository.get(item.id);
      if (!session) return null;

      // Return session without loading messages - they will be loaded
      // on-demand via loadSession() when a specific session is opened.
      // Previously this loaded ALL messages for ALL sessions via N+1 queries,
      // causing ~170+ slow database queries at startup.
      const normalized: ChatSession = {
        ...session,
        messages: [],
      };

      return sessionDataFromChatSession(normalized, workspace);
    })
  );

  return sessions.filter((session): session is SessionData => session !== null);
}

interface UpdateSessionTitleOptions {
  /**
   * Force-update the session title regardless of hasBeenNamed flag.
   * When true, the update skips the atomic guard used by the session naming tool.
   */
  force?: boolean;
  /**
   * Explicitly set the hasBeenNamed flag when force-updating a title.
   * Useful for provisional titles (false) or manual renames (true).
   */
  markAsNamed?: boolean;
}

export class SessionManager {
  private currentSession: SessionData | null = null;
  private currentWorkspacePath: string | null = null;
  private readonly providedStore: SessionStore | null;

  constructor(store?: SessionStore) {
    this.providedStore = store ?? null;
    if (store) {
      setSessionStore(store);
    }
  }

  private resolveStore(): SessionStore | null {
    if (this.providedStore) return this.providedStore;
    if (hasSessionStore()) {
      try {
        return getSessionStore();
      } catch (error) {
        if (process.env.NODE_ENV === 'development') {
          console.warn('[runtime][SessionManager] Failed to access configured session store', error);
        }
      }
    }
    return null;
  }

  cleanupAllSessions(): number {
    // PGlite stores canonical state; no cleanup required beyond removing empty messages on load
    // Return 0 to preserve existing behaviour
    return 0;
  }

  async initialize(): Promise<void> {
    const store = this.resolveStore();
    if (!store) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[runtime][SessionManager] initialize() called without a configured session store');
      }
      return;
    }
    try {
      await store.ensureReady();
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[runtime][SessionManager] Failed to ensure session store readiness', error);
      }
    }
  }

  async createSession(
    provider: AIProviderType,
    documentContext?: DocumentContext,
    workspacePath?: string,
    providerConfig?: any,
    model?: string,
    sessionType?: SessionType,
    mode?: 'planning' | 'agent' | 'auto',
    worktreeId?: string,
    worktreePath?: string,
    worktreeProjectPath?: string,
    agentRole: AgentRole = 'standard',
    createdBySessionId?: string | null
  ): Promise<SessionData> {
    // workspacePath is REQUIRED - sessions cannot exist outside of a workspace
    if (!workspacePath) {
      throw new Error('workspacePath is required to create a session - cannot fall back to default');
    }
    const sessionId = uuidv4();
    const workspace = workspacePath;
    const normalizedModel = normalizeStoredModelIdentifier(provider, model);

    await AISessionsRepository.create({
      id: sessionId,
      provider,
      model: normalizedModel,
      sessionType,
      mode,
      workspaceId: workspace,
      filePath: documentContext?.filePath,
      title: 'New conversation',
      providerConfig,
      documentContext: documentContext ? { ...documentContext } : undefined,
      worktreeId,
      worktreePath,
      worktreeProjectPath,
      agentRole,
      createdBySessionId,
    });

    // Canonical transform columns default to null in the DB schema, so new
    // sessions need no explicit write here. TranscriptTransformer will
    // transform raw ai_agent_messages into canonical ai_transcript_events
    // on first read via ensureTransformed().
    //
    // ensureTransformed() will also pick up any new raw messages on
    // subsequent reads for completed sessions.

    const now = Date.now();
    const session: SessionData = {
      id: sessionId,
      provider,
      model: normalizedModel,
      sessionType,
      mode,
      createdAt: now,
      updatedAt: now,
      messages: [],
      documentContext,
      workspacePath: workspace,
      title: 'New conversation',
      providerConfig,
      worktreeId,
      worktreePath,
      worktreeProjectPath,
      agentRole,
      createdBySessionId: createdBySessionId ?? null,
    };

    this.currentSession = session;
    this.currentWorkspacePath = workspace;
    return session;
  }

  async branchSession(
    parentSessionId: string,
    branchPointMessageId?: number,
    workspacePath?: string
  ): Promise<SessionData> {
    // Load the parent session to get its configuration
    const parentSession = await this.loadSession(parentSessionId, workspacePath);
    if (!parentSession) {
      throw new Error(`Parent session ${parentSessionId} not found`);
    }

    // Create a new session ID for the branch
    const branchSessionId = uuidv4();
    const workspace = parentSession.workspacePath;
    if (!workspace) {
      throw new Error(`Parent session ${parentSessionId} has no workspacePath`);
    }
    const now = Date.now();

    // Determine branch title with counter for duplicates
    // Get existing branches to determine the next counter
    const existingBranches = await AISessionsRepository.getBranches(parentSessionId);

    // Strip "(branch)" or "(branch N)" prefix from parent title if present
    const baseTitle = parentSession.title?.replace(/^\(branch(?: \d+)?\)\s+/, '') || 'Untitled';

    let branchTitle: string;
    if (existingBranches.length === 0) {
      // First branch - no counter
      branchTitle = `(branch) ${baseTitle}`;
    } else {
      // Find the highest existing counter
      let maxCounter = 1; // Start at 1 since first branch has no counter
      for (const branch of existingBranches) {
        const match = branch.title?.match(/^\(branch (\d+)\)/);
        if (match) {
          maxCounter = Math.max(maxCounter, parseInt(match[1], 10));
        }
      }
      branchTitle = `(branch ${maxCounter + 1}) ${baseTitle}`;
    }

    // Store source session's providerSessionId so we can fork from it
    // This is the Claude SDK's session ID that we need to resume from
    const branchedFromProviderSessionId = parentSession.providerSessionId;

    // Create the branch session with branch tracking
    // NOTE: branchedFromSessionId is SEPARATE from parentSessionId (hierarchical workstreams)
    await AISessionsRepository.create({
      id: branchSessionId,
      provider: parentSession.provider,
      model: parentSession.model,
      sessionType: parentSession.sessionType,
      mode: parentSession.mode,
      workspaceId: workspace,
      filePath: parentSession.documentContext?.filePath,
      title: branchTitle,
      providerConfig: parentSession.providerConfig as Record<string, unknown> | undefined,
      documentContext: parentSession.documentContext as Record<string, unknown> | undefined,
      worktreeId: parentSession.worktreeId,
      worktreePath: parentSession.worktreePath,
      worktreeProjectPath: parentSession.worktreeProjectPath,
      branchedFromSessionId: parentSessionId,  // The session this branch was forked from
      branchPointMessageId,
      branchedAt: now,
    });

    const session: SessionData = {
      id: branchSessionId,
      provider: parentSession.provider,
      model: parentSession.model,
      sessionType: parentSession.sessionType,
      mode: parentSession.mode,
      createdAt: now,
      updatedAt: now,
      messages: [],
      documentContext: parentSession.documentContext,
      workspacePath: workspace,
      title: branchTitle,
      providerConfig: parentSession.providerConfig,
      worktreeId: parentSession.worktreeId,
      worktreePath: parentSession.worktreePath,
      worktreeProjectPath: parentSession.worktreeProjectPath,
      branchedFromSessionId: parentSessionId,  // The session this branch was forked from
      branchPointMessageId,
      branchedAt: now,
      // Store source session's provider session ID for forking
      branchedFromProviderSessionId,
    };

    this.currentSession = session;
    this.currentWorkspacePath = workspace;
    return session;
  }

  async loadSession(sessionId: string, workspacePath?: string): Promise<SessionData | null> {
    // workspacePath is REQUIRED for proper session routing
    if (!workspacePath && !this.currentWorkspacePath) {
      throw new Error('workspacePath is required to load a session - cannot fall back to default');
    }
    const workspace = workspacePath || this.currentWorkspacePath!;

    const session = await AISessionsRepository.get(sessionId);
    if (!session) {
      console.log('[SessionManager] Session not found in database:', sessionId);
      return null;
    }

    // console.log('[SessionManager] Session found in database:', {
    //   sessionId: session.id,
    //   sessionWorkspacePath: session.workspacePath,
    //   requestedWorkspace: workspace,
    //   worktreeId: session.worktreeId,
    //   worktreePath: session.worktreePath
    // });

    // Validate workspace ownership to prevent cross-workspace session loading
    // This prevents bugs where a session ID from one workspace could be loaded
    // in another workspace (e.g., if the tab state got corrupted)
    // For worktree sessions: accept either the parent workspace path OR the worktree path
    const isValidWorkspace = session.workspacePath === workspace ||
      (session.worktreePath && session.worktreePath === workspace);

    if (session.workspacePath && !isValidWorkspace) {
      console.warn(
        `[SessionManager] Rejecting session ${sessionId}: belongs to ${session.workspacePath} (worktree: ${session.worktreePath}), not ${workspace}`
      );
      return null;
    }

    // Load transcript from canonical ai_transcript_events table
    // These are already TranscriptViewMessage[] -- do NOT pass through
    // viewMessageFromServerMessage (which expects the old Message format).
    const uiMessages = await this.loadCanonicalTranscript(sessionId, session.provider);

    // Build session data, then overwrite messages with the already-projected ones
    const sessionData = sessionDataFromChatSession(session, workspace);
    sessionData.messages = uiMessages;

    // Fallback: If no tokenUsage in metadata, try parsing from /context responses
    // This provides backwards compatibility for sessions created before tokenUsage was stored in metadata
    if (!sessionData.tokenUsage) {
      const agentMessages = await AgentMessagesRepository.list(sessionId);
      for (let i = agentMessages.length - 1; i >= 0; i--) {
        const msg = agentMessages[i];
        if (msg.direction === 'output' && msg.content?.includes('## Context Usage')) {
          const parsedUsage = parseContextUsageMessage(msg.content);
          if (parsedUsage) {
            sessionData.tokenUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: parsedUsage.totalTokens,
              contextWindow: parsedUsage.contextWindow,
              categories: parsedUsage.categories
            };
            break;
          }
        }
      }
    }

    this.currentSession = sessionData;
    this.currentWorkspacePath = sessionData.workspacePath ?? workspace;
    return sessionData;
  }

  /**
   * Load transcript via canonical ai_transcript_events path.
   * Lazily transforms old sessions on first access.
   * Returns projected TranscriptViewMessage[] directly -- no legacy conversion.
   */
  private async loadCanonicalTranscript(sessionId: string, provider: string): Promise<TranscriptViewMessage[]> {
    if (!TranscriptMigrationRepository.hasService()) {
      throw new Error('TranscriptMigrationService not available');
    }

    return TranscriptMigrationRepository.getService().getViewMessages(sessionId, provider);
  }

  async getSessions(workspacePath?: string): Promise<SessionData[]> {
    // workspacePath is REQUIRED - sessions are always scoped to a workspace
    if (!workspacePath && !this.currentWorkspacePath) {
      throw new Error('workspacePath is required to get sessions - cannot fall back to default');
    }
    const workspace = workspacePath || this.currentWorkspacePath!;
    return fetchSessionsForWorkspace(workspace);
  }

  /**
   * Get lightweight session list (just metadata, no messages).
   * Much faster than getSessions() - use when you only need id/title.
   */
  async getSessionList(workspacePath?: string): Promise<SessionMeta[]> {
    // workspacePath is REQUIRED - sessions are always scoped to a workspace
    if (!workspacePath && !this.currentWorkspacePath) {
      throw new Error('workspacePath is required to get session list - cannot fall back to default');
    }
    const workspace = workspacePath || this.currentWorkspacePath!;
    return AISessionsRepository.list(workspace);
  }

  getCurrentSession(): SessionData | null {
    return this.currentSession;
  }

  clearCurrentSession(): void {
    this.currentSession = null;
  }

  async addMessage(message: Message, sessionId?: string): Promise<void> {
    const targetId = sessionId || this.currentSession?.id;
    if (!targetId) {
      throw new Error('No session ID provided and no current session loaded');
    }

    // Messages are now stored in ai_agent_messages table via provider logAgentMessage()
    // Only update in-memory session state for backward compatibility
    if (this.currentSession?.id === targetId) {
      this.currentSession = {
        ...this.currentSession,
        messages: [...(this.currentSession.messages || []), viewMessageFromServerMessage(message)],
        updatedAt: Date.now(),
      };
    }
  }

  async updateSessionMessages(sessionId: string, messages: Message[], workspacePath?: string): Promise<boolean> {
    // Messages are now stored in ai_agent_messages table via provider logAgentMessage()
    // Only update in-memory session state for backward compatibility
    if (this.currentSession?.id === sessionId) {
      this.currentSession = {
        ...this.currentSession,
        messages: messages.map(viewMessageFromServerMessage),
        updatedAt: Date.now(),
      };
    }
    return true;
  }

  async saveDraftInput(sessionId: string, draftInput: string, workspacePath?: string): Promise<boolean> {
    await AISessionsRepository.updateMetadata(sessionId, { draftInput });
    if (this.currentSession?.id === sessionId) {
      this.currentSession = { ...this.currentSession, draftInput };
    }
    return true;
  }

  async deleteSession(sessionId: string, workspacePath?: string): Promise<boolean> {
    await AISessionsRepository.delete(sessionId);
    if (this.currentSession?.id === sessionId) {
      this.currentSession = null;
    }
    return true;
  }

  async updateProviderSessionData(sessionId: string, providerSessionId?: string): Promise<void> {
    await AISessionsRepository.updateMetadata(sessionId, { providerSessionId });
    if (this.currentSession?.id === sessionId) {
      this.currentSession = { ...this.currentSession, providerSessionId };
    }
  }

  private async assertProviderSwitchAllowed(sessionId: string, targetProvider: string): Promise<void> {
    const persistedSession = await AISessionsRepository.get(sessionId);
    const session = this.currentSession?.id === sessionId ? this.currentSession : persistedSession;
    if (!session) {
      throw new Error('Session not found');
    }

    if (shouldBlockStartedSessionProviderSwitch(
      session.provider,
      targetProvider,
      session.messages.length > 0 || (persistedSession?.messages.length ?? 0) > 0
    )) {
      throw new Error(
        `Cannot switch started session from ${session.provider} to ${targetProvider}. Start a new session instead.`
      );
    }
  }

  async updateSessionTitle(sessionId: string, title: string, options?: UpdateSessionTitleOptions): Promise<void> {
    if (options?.force) {
      const metadata: UpdateSessionMetadataPayload = { title };
      if (options.markAsNamed !== undefined) {
        (metadata as any).hasBeenNamed = options.markAsNamed;
      }
      await AISessionsRepository.updateMetadata(sessionId, metadata);
    } else {
      const updated = await AISessionsRepository.updateTitleIfNotNamed(sessionId, title);
      if (!updated) {
        throw new Error('Session has already been named');
      }
    }
    if (this.currentSession?.id === sessionId) {
      const updatedSession: SessionData = { ...this.currentSession, title };
      if (options?.markAsNamed !== undefined) {
        updatedSession.hasBeenNamed = options.markAsNamed;
      } else if (!options?.force) {
        updatedSession.hasBeenNamed = true;
      }
      this.currentSession = updatedSession;
    }
  }

  async updateSessionModel(sessionId: string, model: string): Promise<void> {
    const normalizedModel = normalizeStoredModelIdentifier(undefined, model) ?? model;
    console.log(`[SessionManager] updateSessionModel called: sessionId=${sessionId}, model=${normalizedModel}`);
    const parsedModel = ModelIdentifier.tryParse(normalizedModel);
    if (parsedModel) {
      await this.assertProviderSwitchAllowed(sessionId, parsedModel.provider);
    }
    await AISessionsRepository.updateMetadata(sessionId, { model: normalizedModel });
    console.log(`[SessionManager] Database updated with new model`);
    if (this.currentSession?.id === sessionId) {
      console.log(`[SessionManager] Updating current session model from ${this.currentSession.model} to ${normalizedModel}`);
      this.currentSession = { ...this.currentSession, model: normalizedModel };
    }
  }

  async updateSessionProviderAndModel(sessionId: string, provider: string, model: string): Promise<void> {
    const normalizedModel = normalizeStoredModelIdentifier(provider, model) ?? model;
    console.log(`[SessionManager] updateSessionProviderAndModel called: sessionId=${sessionId}, provider=${provider}, model=${normalizedModel}`);
    await this.assertProviderSwitchAllowed(sessionId, provider);
    await AISessionsRepository.updateMetadata(sessionId, {
      provider,
      model: normalizedModel
    });
    console.log(`[SessionManager] Database updated with new provider and model`);
    if (this.currentSession?.id === sessionId) {
      console.log(`[SessionManager] Updating current session: provider ${this.currentSession.provider} -> ${provider}, model ${this.currentSession.model} -> ${normalizedModel}`);
      this.currentSession = {
        ...this.currentSession,
        provider: provider as AIProviderType,
        model: normalizedModel
      };
    }
  }

  async updateSessionDraftInput(sessionId: string, draftInput: string): Promise<void> {
    await AISessionsRepository.updateMetadata(sessionId, { draftInput });
    if (this.currentSession?.id === sessionId) {
      this.currentSession = { ...this.currentSession, draftInput };
    }
  }

  /**
   * Update session token usage in metadata
   * This persists cumulative token usage for the session
   */
  async updateSessionTokenUsage(sessionId: string, tokenUsage: SessionData['tokenUsage']): Promise<void> {
    // Get current metadata and merge token usage into it
    const session = await AISessionsRepository.get(sessionId);
    const currentMetadata = (session?.metadata ?? {}) as Record<string, unknown>;

    await AISessionsRepository.updateMetadata(sessionId, {
      metadata: {
        ...currentMetadata,
        tokenUsage
      }
    });

    if (this.currentSession?.id === sessionId) {
      this.currentSession = {
        ...this.currentSession,
        tokenUsage,
        metadata: {
          ...(this.currentSession.metadata ?? {}),
          tokenUsage
        }
      };
    }
  }
}
