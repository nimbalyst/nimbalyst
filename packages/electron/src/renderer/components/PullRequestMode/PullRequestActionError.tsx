import { useState } from 'react';

export const GH_WORKFLOW_SCOPE_REFRESH_COMMAND = 'gh auth refresh -h github.com -s workflow';

interface PullRequestActionErrorProps {
  error: string;
}

export function PullRequestActionError({ error }: PullRequestActionErrorProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const hasWorkflowScopeRecovery = error.includes(GH_WORKFLOW_SCOPE_REFRESH_COMMAND);

  const copyRecoveryCommand = () => {
    navigator.clipboard.writeText(GH_WORKFLOW_SCOPE_REFRESH_COMMAND).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <span
      className="pr-action-error text-nim-error text-[11px] max-w-[480px] whitespace-normal"
      role="alert"
      title={error}
    >
      {error}
      {hasWorkflowScopeRecovery && (
        <button
          type="button"
          className="ml-2 text-nim-accent hover:underline text-[11px]"
          onClick={copyRecoveryCommand}
          data-testid="pr-copy-workflow-scope-command"
        >
          {copied ? 'Copied' : 'Copy command'}
        </button>
      )}
    </span>
  );
}
