export interface VoiceTaskCompletionInput {
  summary?: string;
  error?: string;
}

export interface VoiceTaskCompletion {
  deferredResult:
    | { success: true; summary: string }
    | { success: false; error: string };
  fallbackMessage: string;
}

const MAX_VOICE_COMPLETION_LENGTH = 1500;

function truncateForVoice(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_VOICE_COMPLETION_LENGTH
    ? trimmed.substring(0, MAX_VOICE_COMPLETION_LENGTH) + '... (truncated)'
    : trimmed;
}

export function buildVoiceTaskCompletion(input: VoiceTaskCompletionInput): VoiceTaskCompletion {
  const error = truncateForVoice(input.error ?? '');
  if (error) {
    return {
      deferredResult: { success: false, error },
      fallbackMessage: `[INTERNAL: Task failed. Error: ${error}]`,
    };
  }

  const summary = truncateForVoice(input.summary ?? '');
  const resolvedSummary = summary || 'The coding agent finished but did not produce a text summary.';
  return {
    deferredResult: { success: true, summary: resolvedSummary },
    fallbackMessage: summary
      ? `[INTERNAL: Task complete. Result: ${summary}]`
      : '[INTERNAL: Task complete. The coding agent finished but did not produce a text summary.]',
  };
}
