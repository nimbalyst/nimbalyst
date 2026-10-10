/** Observed Ollama account activity; request counts are not credit limits. */
export interface OllamaRequestUsage {
  requestCount: number;
  from: string;
  until: string;
}

export function isUsageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function usageTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12
    && Number(dayText) >= 1 && Number(dayText) <= daysInMonth[month - 1]
    && Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59
    && (!offsetHourText || Number(offsetHourText) <= 23)
    && (!offsetMinuteText || Number(offsetMinuteText) <= 59)
    && Number.isFinite(Date.parse(value));
}

/** Keep partial-day activity cutoffs and the timezone visible in both UI surfaces. */
export function formatOllamaUsageTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZone: 'UTC', timeZoneName: 'short',
  }).format(new Date(value));
}

export function parseOllamaRequestUsage(value: unknown): OllamaRequestUsage | undefined {
  if (!isUsageRecord(value) || !isUsageRecord(value.totals)) return undefined;
  const requestCount = value.totals.request_count;
  if (typeof requestCount !== 'number' || !Number.isSafeInteger(requestCount) || requestCount < 0) return undefined;
  if (!usageTimestamp(value.from) || !usageTimestamp(value.until) || Date.parse(value.from) >= Date.parse(value.until)) return undefined;
  return { requestCount, from: value.from, until: value.until };
}
