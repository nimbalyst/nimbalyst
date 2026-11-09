import type { SessionData } from '@nimbalyst/runtime/ai/server/types';

export interface RemoteSessionSnapshot {
  session: SessionData;
  connected: boolean;
  hostOnline: boolean;
  syncing: boolean;
  executing: boolean;
  queuedPrompts: Array<{ id: string; prompt: string; timestamp: number }>;
  error?: string;
  readOnlyReason?: string;
  /** Only desktop hosts resolve prompt answers sent from another device. */
  canAnswerPrompts: boolean;
}

/** An answer to a pending agent prompt, delivered to the host as a `prompt_response` control message. */
export type RemotePromptResponse =
  | { promptType: 'ask_user_question'; promptId: string; response: { answers: Record<string, string>; cancelled?: boolean } }
  | { promptType: 'request_user_input'; promptId: string; response: { answers: Record<string, unknown>; cancelled?: boolean } }
  | { promptType: 'exit_plan_mode'; promptId: string; response: { approved: boolean; feedback?: string } }
  | { promptType: 'tool_permission'; promptId: string; response: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' } }
  | { promptType: 'git_commit'; promptId: string; response: { action: 'committed' | 'cancelled'; files?: string[]; message?: string } };
