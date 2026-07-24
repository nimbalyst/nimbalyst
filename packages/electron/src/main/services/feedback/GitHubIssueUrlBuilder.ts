export const FEEDBACK_REPO = 'nimbalyst/nimbalyst';
export const FEEDBACK_ISSUES_URL = `https://github.com/${FEEDBACK_REPO}/issues`;
export const FEEDBACK_DISCUSSIONS_URL = `https://github.com/${FEEDBACK_REPO}/discussions`;
export const FEEDBACK_SUPPORT_EMAIL = 'support@nimbalyst.com';

export type FeedbackKind = 'bug' | 'feature';

export interface BuildIssueUrlInput {
  kind: FeedbackKind;
  title: string;
  body: string;
}

export interface BuildIssueUrlResult {
  /** True when the resulting URL is short enough to use without truncation. */
  ok: boolean;
  /** When ok=false, this is the *fallback* URL with the body omitted (title still pre-filled). */
  url: string;
  /** When ok=false, an explanation. */
  reason?: 'too-long';
}

const SAFE_URL_LENGTH = 6000;

const TEMPLATE_BY_KIND: Record<FeedbackKind, string> = {
  bug: 'bug_report.yml',
  feature: 'feature_request.yml',
};

// Issue-form field IDs (must match the `id:` values in the .yml templates).
// `.yml` issue forms ignore the legacy `?body=` param -- prefill happens per
// field id instead.
const BODY_FIELD_BY_KIND: Record<FeedbackKind, string> = {
  bug: 'problem',
  feature: 'request',
};

function buildBaseUrl(kind: FeedbackKind, title: string, body?: string): string {
  const params = new URLSearchParams();
  params.set('template', TEMPLATE_BY_KIND[kind]);
  if (title) params.set('title', title);
  if (body) params.set(BODY_FIELD_BY_KIND[kind], body);
  return `https://github.com/${FEEDBACK_REPO}/issues/new?${params.toString()}`;
}

export function buildIssueUrl(input: BuildIssueUrlInput): BuildIssueUrlResult {
  const fullUrl = buildBaseUrl(input.kind, input.title, input.body);
  if (fullUrl.length <= SAFE_URL_LENGTH) {
    return { ok: true, url: fullUrl };
  }

  const titleOnlyUrl = buildBaseUrl(input.kind, input.title);
  return { ok: false, url: titleOnlyUrl, reason: 'too-long' };
}
