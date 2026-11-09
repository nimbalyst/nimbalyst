import type { TranscriptViewMessage } from '../../../ai/server/types';
import { isAnswerResumePrompt, isQuestionTool, stripMcpPrefix } from '../../../ai/server/interactivePromptTools';
import type { RequestUserInputAnswer, RequestUserInputField } from '../../../ai/server/providers/shared/requestUserInputTypes';
import { formatISO } from '../../../utils/dateUtils';
import type { PromptMarker } from '../types';
import { isToolLikeMessage } from './messageTypeHelpers';
import { erroredQuestionOutcome, parseAnswers, parseCancelledResult } from '../components/CustomToolWidgets/askUserQuestionResult';
import { parseRequestUserInputResult } from '../components/CustomToolWidgets/requestUserInputFieldLogic';

interface AnsweredQuestion {
  question: string;
  answer: string;
}

function summarizeAskUserQuestion(args: any, result: unknown): AnsweredQuestion | null {
  if (parseCancelledResult(result).cancelled) return null;
  const answers = parseAnswers(args, result);
  const entries = Object.entries(answers).filter(([, value]) => typeof value === 'string' && value);
  if (entries.length === 0) return null;
  const questions: Array<{ question?: unknown; header?: unknown }> = Array.isArray(args?.questions) ? args.questions : [];
  const first = questions.find(q => typeof q?.question === 'string' && answers[q.question as string]);
  const question = typeof first?.question === 'string' ? first.question : entries[0][0];
  const more = entries.length > 1 ? ` (+${entries.length - 1} more)` : '';
  return { question: question + more, answer: entries.map(([, value]) => value).join('; ') };
}

function describeFieldAnswer(field: RequestUserInputField | undefined, answer: RequestUserInputAnswer): string {
  const itemTitle = (id: string): string => {
    if (field?.type === 'multiSelect' || field?.type === 'reorder') {
      return field.items.find(item => item.id === id)?.title ?? id;
    }
    if (field?.type === 'singleSelect') {
      return field.options.find(option => option.id === id)?.label ?? id;
    }
    return id;
  };
  switch (answer.type) {
    case 'singleSelect':
      return answer.otherText || itemTitle(answer.selectedId);
    case 'multiSelect':
      return answer.selectedIds.map(itemTitle).join(', ');
    case 'reorder':
      return answer.orderedIds.map(itemTitle).join(' > ');
    case 'editText':
      return answer.text.replace(/\s+/g, ' ').trim();
    case 'confirm':
      return answer.value ? 'Yes' : 'No';
    default:
      return '';
  }
}

function summarizeRequestUserInput(args: any, result: unknown): AnsweredQuestion | null {
  const parsed = parseRequestUserInputResult(result);
  if (!parsed || parsed.cancelled) return null;
  const fields: RequestUserInputField[] = Array.isArray(args?.fields) ? args.fields : [];
  const parts: string[] = [];
  for (const [fieldId, answer] of Object.entries(parsed.answers)) {
    if (!answer || typeof answer !== 'object') continue;
    const text = describeFieldAnswer(fields.find(f => f?.id === fieldId), answer);
    if (text) parts.push(text);
  }
  if (parts.length === 0) return null;
  const title = typeof args?.title === 'string' && args.title
    ? args.title
    : fields.find(f => typeof f?.label === 'string')?.label ?? 'Question';
  return { question: title, answer: parts.join('; ') };
}

function summarizeAnsweredQuestion(message: TranscriptViewMessage): AnsweredQuestion | null {
  const tool = message.toolCall;
  if (!tool?.result) return null;
  // An errored result is never an answer, whatever its text looks like (#1577).
  if (erroredQuestionOutcome(tool)) return null;
  return stripMcpPrefix(tool.toolName) === 'AskUserQuestion'
    ? summarizeAskUserQuestion(tool.arguments, tool.result)
    : summarizeRequestUserInput(tool.arguments, tool.result);
}

/** The transcript row that renders a tool call: the assistant row after its tool group. */
function enclosingRowIndex(messages: TranscriptViewMessage[], index: number): number {
  let rowIndex = index;
  while (rowIndex < messages.length && isToolLikeMessage(messages[rowIndex])) rowIndex++;
  return messages[rowIndex]?.type === 'assistant_message' ? rowIndex : index;
}

/**
 * Build the prompts menu entries, in transcript order: the user's own prompts,
 * prompts sent by other sessions, and the user's answers to question tools.
 * System sends and the auto-resume after an answer are left out; the answer
 * entry stands for the latter.
 */
export function buildPromptMarkers(
  messages: TranscriptViewMessage[],
  sessionId: string,
  isProcessing: boolean,
): PromptMarker[] {
  // Provider echoes can repeat a tool call; the last occurrence wins.
  const lastQuestionIndex = new Map<string, number>();
  messages.forEach((msg, index) => {
    const id = msg.toolCall?.providerToolCallId;
    if (id && isQuestionTool(msg.toolCall?.toolName)) lastQuestionIndex.set(id, index);
  });

  const userIndexes: number[] = [];
  messages.forEach((msg, index) => {
    if (msg.type === 'user_message') userIndexes.push(index);
  });
  const lastUserIndex = userIndexes[userIndexes.length - 1];

  const completionAfter = (index: number): string | undefined => {
    if (index === lastUserIndex && isProcessing) return undefined;
    const next = userIndexes.find(i => i > index) ?? messages.length;
    for (let i = next - 1; i > index; i--) {
      if (messages[i].type !== 'user_message') return formatISO(messages[i].createdAt.getTime()) || undefined;
    }
    return undefined;
  };

  const markers: PromptMarker[] = [];
  let promptNumber = 0;
  messages.forEach((msg, index) => {
    const timestamp = formatISO(msg.createdAt.getTime()) || new Date().toISOString();
    if (msg.type === 'user_message') {
      if (msg.promptActor === 'system' || isAnswerResumePrompt(msg)) return;
      const fromAgent = msg.promptActor === 'agent';
      markers.push({
        id: markers.length + 1,
        sessionId,
        kind: fromAgent ? 'agentPrompt' : 'prompt',
        ...(fromAgent ? {} : { promptNumber: ++promptNumber }),
        promptText: msg.text ?? '',
        outputIndex: index,
        timestamp,
        completionTimestamp: completionAfter(index),
      });
      return;
    }
    const toolCallId = msg.toolCall?.providerToolCallId;
    if (!toolCallId || lastQuestionIndex.get(toolCallId) !== index) return;
    const answered = summarizeAnsweredQuestion(msg);
    if (!answered) return;
    markers.push({
      id: markers.length + 1,
      sessionId,
      kind: 'answer',
      promptText: answered.question,
      answerText: answered.answer,
      toolCallId,
      outputIndex: enclosingRowIndex(messages, index),
      timestamp,
    });
  });
  return markers;
}
