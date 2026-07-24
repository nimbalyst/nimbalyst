import os from 'os';
import { app, shell } from 'electron';
import { anonymize } from '../../services/feedback/LogAnonymizer';
import {
  buildIssueUrl,
  FEEDBACK_REPO,
  type FeedbackKind,
} from '../../services/feedback/GitHubIssueUrlBuilder';

type McpToolResult = {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
};

export const feedbackToolSchemas = [
  {
    name: 'feedback_anonymize_text',
    description:
      'Anonymize a string before showing it to the user or pasting it into a feedback report. Replaces the home directory with `~`, known workspace paths with `<WORKSPACE>`, emails with `<EMAIL>`, API keys / JWTs / Stytch IDs with `<REDACTED_*>`, and private IPv4 addresses with `<LOCAL_IP>`. Use this on any log slice, file path, or environment string before it lands in a draft issue body.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to anonymize. Returned anonymized.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'feedback_get_environment',
    description:
      'Return a small environment summary for inclusion in a feedback report: app version, OS, architecture, Electron / Node / Chrome versions. Safe to call without consent — does not read logs.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'feedback_open_github_issue',
    description: `Open a pre-filled GitHub new-issue page in the user's browser, targeting ${FEEDBACK_REPO}. Picks the right issue-form template (bug_report.yml or feature_request.yml) based on \`kind\` and routes the body into the template's primary textarea field. Type ("Bug" / "Feature") and the \`status:needs-triage\` label come from the template's frontmatter. Returns { ok: true } when the URL was short enough to include the body. Returns { ok: false, reason: "too-long", url } when the body would have been truncated — in that case, show the body in chat as a code block, open the returned URL (title only), and tell the user to paste. The user must approve before this is called.`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['bug', 'feature'],
          description: 'Bug report or feature request. Determines template and label.',
        },
        title: {
          type: 'string',
          description: 'A concise issue title (one sentence).',
        },
        body: {
          type: 'string',
          description: 'The full markdown issue body, already reviewed and approved by the user.',
        },
      },
      required: ['kind', 'title', 'body'],
    },
  },
];

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function jsonResult(value: unknown, isError = false): McpToolResult {
  return textResult(JSON.stringify(value, null, 2), isError);
}

export function handleFeedbackAnonymizeText(args: any, callerWorkspacePath?: string): McpToolResult {
  const text = typeof args?.text === 'string' ? args.text : '';
  if (!text) {
    return textResult('Error: `text` is required and must be a non-empty string.', true);
  }

  const homeDir = os.homedir();
  // Scrub the reporting session's workspace path too, not just the home dir.
  // Workspaces commonly live outside the home directory (e.g. C:\Projects\...),
  // so without this they pass through verbatim and leak directory names into
  // the public GitHub issue.
  const workspacePaths = callerWorkspacePath ? [callerWorkspacePath] : [];
  const result = anonymize(text, { homeDir, workspacePaths });
  return textResult(result);
}

export function handleFeedbackGetEnvironment(): McpToolResult {
  const summary = {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
  };
  return jsonResult(summary);
}

export async function handleFeedbackOpenGithubIssue(args: any): Promise<McpToolResult> {
  const kind = args?.kind as FeedbackKind | undefined;
  const title = typeof args?.title === 'string' ? args.title : '';
  const body = typeof args?.body === 'string' ? args.body : '';

  if (kind !== 'bug' && kind !== 'feature') {
    return textResult('Error: `kind` must be "bug" or "feature".', true);
  }
  if (!title.trim()) {
    return textResult('Error: `title` is required.', true);
  }
  if (!body.trim()) {
    return textResult('Error: `body` is required.', true);
  }

  const built = buildIssueUrl({ kind, title, body });

  try {
    await shell.openExternal(built.url);
  } catch (err) {
    return jsonResult(
      {
        ok: false,
        opened: false,
        reason: 'open-failed',
        url: built.url,
        error: err instanceof Error ? err.message : String(err),
      },
      true,
    );
  }

  if (!built.ok) {
    return jsonResult({
      ok: false,
      opened: true,
      reason: built.reason,
      url: built.url,
      note: 'The body was too long to fit in the URL. The browser was opened with the title pre-filled only. Show the user the full body so they can paste it into the GitHub issue form.',
    });
  }

  return jsonResult({ ok: true, opened: true, url: built.url });
}
