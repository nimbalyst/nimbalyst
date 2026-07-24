export interface AskUserQuestionPromptOption {
  label: string;
  description: string;
}

export interface AskUserQuestionPrompt {
  question: string;
  header: string;
  options: AskUserQuestionPromptOption[];
  multiSelect: boolean;
}
