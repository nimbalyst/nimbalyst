const MAX_EXTERNAL_URL_LENGTH = 2048;

/**
 * Normalize the custom-editor external-reference boundary. This intentionally
 * supports HTTPS only; additional protocols require an explicit host decision.
 */
export function normalizeExternalHttpsUrl(candidate: string): string {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.length > MAX_EXTERNAL_URL_LENGTH) {
    throw new Error('External URL is empty or too long.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('External URL is invalid.');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error('External URL must be an HTTPS URL without embedded credentials.');
  }
  return parsed.href;
}
