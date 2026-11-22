import { useMemo } from 'react';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface TimelineRulerProps {
  rangeMin: number;
  rangeMax: number;
  pxPerDay: number;
  /** Width of the content area in px (= span-in-days * pxPerDay). */
  contentWidth: number;
}

export interface Tick {
  ms: number;
  x: number;
  label: string;
  major: boolean;
}

type StepUnit = 'hour' | 'day' | 'month' | 'year';

/**
 * Pick a tick interval so ticks land roughly every ~110px regardless of zoom.
 */
function chooseStep(pxPerDay: number): { unit: StepUnit; n: number } {
  const targetPx = 110;
  const daysPerTarget = targetPx / Math.max(pxPerDay, 0.0001);
  for (const h of [1, 2, 3, 6, 12]) if (h / 24 >= daysPerTarget) return { unit: 'hour', n: h };
  for (const d of [1, 2, 7, 14]) if (d >= daysPerTarget) return { unit: 'day', n: d };
  for (const m of [1, 2, 3, 6]) if (m * 30 >= daysPerTarget) return { unit: 'month', n: m };
  return { unit: 'year', n: Math.max(1, Math.ceil(daysPerTarget / 365)) };
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtHour(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric' });
}
function fmtMonth(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short' });
}

/**
 * Ruler ticks for `[rangeMin, rangeMax]` at the given zoom. Hour ticks label
 * midnight with the date (as a major tick) so a 24-hour range stays anchored.
 */
export function buildRulerTicks(rangeMin: number, rangeMax: number, pxPerDay: number): Tick[] {
  const span = rangeMax - rangeMin;
  if (span <= 0 || !Number.isFinite(span)) return [];
  const x = (ms: number) => ((ms - rangeMin) / DAY) * pxPerDay;
  const { unit, n } = chooseStep(pxPerDay);
  const out: Tick[] = [];
  let lastYear = -1;

  if (unit === 'hour') {
    const step = n * HOUR;
    // Align to local midnight so steps land on round hours (0, 6, 12, ...).
    let t = startOfDay(rangeMin);
    while (t < rangeMin) t += step;
    for (; t <= rangeMax; t += step) {
      const isMidnight = new Date(t).getHours() === 0;
      out.push({ ms: t, x: x(t), label: isMidnight ? fmtDay(t) : fmtHour(t), major: isMidnight });
      if (out.length > 400) break;
    }
  } else if (unit === 'day') {
    const step = n * DAY;
    let t = startOfDay(rangeMin);
    for (; t <= rangeMax + step; t += step) {
      const year = new Date(t).getFullYear();
      const major = new Date(t).getDate() === 1;
      const label = year !== lastYear ? `${fmtDay(t)} ${String(year).slice(2)}` : fmtDay(t);
      lastYear = year;
      out.push({ ms: t, x: x(t), label, major });
      if (out.length > 400) break;
    }
  } else if (unit === 'month') {
    const d = new Date(rangeMin);
    d.setDate(1); d.setHours(0, 0, 0, 0);
    for (; d.getTime() <= rangeMax; d.setMonth(d.getMonth() + n)) {
      const t = d.getTime();
      const year = d.getFullYear();
      const major = d.getMonth() === 0;
      const label = year !== lastYear ? `${fmtMonth(t)} ${String(year).slice(2)}` : fmtMonth(t);
      lastYear = year;
      out.push({ ms: t, x: x(t), label, major });
      if (out.length > 400) break;
    }
  } else {
    const d = new Date(rangeMin);
    d.setMonth(0, 1); d.setHours(0, 0, 0, 0);
    for (; d.getTime() <= rangeMax; d.setFullYear(d.getFullYear() + n)) {
      const t = d.getTime();
      out.push({ ms: t, x: x(t), label: String(d.getFullYear()), major: true });
      if (out.length > 400) break;
    }
  }
  return out;
}

export function TimelineRuler({ rangeMin, rangeMax, pxPerDay, contentWidth }: TimelineRulerProps) {
  const ticks = useMemo(() => buildRulerTicks(rangeMin, rangeMax, pxPerDay), [rangeMin, rangeMax, pxPerDay]);

  return (
    <div className="pg-tl-ruler" style={{ width: contentWidth }} aria-hidden="true">
      {ticks.map(t => (
        <div
          key={t.ms}
          className={`pg-tl-tick${t.major ? ' is-major' : ''}`}
          style={{ left: t.x }}
        >
          <span className="pg-tl-tick-label">{t.label}</span>
        </div>
      ))}
    </div>
  );
}
