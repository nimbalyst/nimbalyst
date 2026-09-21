/** Provider diagnostics can echo credentials; never log raw transport errors. */
export function redactVoiceDiagnostic(value: unknown, apiKey: string): string {
  const message = value instanceof Error
    ? value.message
    : typeof value === 'string' ? value : 'Voice transport error';
  const redacted = apiKey ? message.split(apiKey).join('[REDACTED]') : message;
  // Providers may echo a masked key instead of the complete configured value.
  return redacted.replace(/\bsk-[A-Za-z0-9_*-]+/g, '[REDACTED]');
}
