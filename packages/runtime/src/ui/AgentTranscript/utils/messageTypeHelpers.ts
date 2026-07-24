import type { TranscriptViewMessage } from '../../../ai/server/types';

/** Returns true for tool_call, interactive_prompt, and subagent message types. */
export function isToolLikeMessage(msg: TranscriptViewMessage): boolean {
  return msg.type === 'tool_call' || msg.type === 'interactive_prompt' || msg.type === 'subagent';
}
