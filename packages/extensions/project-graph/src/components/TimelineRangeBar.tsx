import { useEffect, useState } from 'react';
import {
  dateRangeFromInputs,
  formatDateInput,
  recentDateRange,
  type TimelineDateRange,
} from '../timeline/dateRange';

interface TimelineRangeBarProps {
  range: TimelineDateRange | null;
  onChange: (range: TimelineDateRange | null) => void;
  onClose: () => void;
}

function rangeLabel(range: TimelineDateRange): string {
  const format = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return `${format.format(range.startMs)} – ${format.format(range.endMs)}`;
}

export function TimelineRangeBar({ range, onChange, onClose }: TimelineRangeBarProps) {
  const fallback = recentDateRange(30);
  const [start, setStart] = useState(() => formatDateInput(range?.startMs ?? fallback.startMs));
  const [end, setEnd] = useState(() => formatDateInput(range?.endMs ?? fallback.endMs));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!range) return;
    setStart(formatDateInput(range.startMs));
    setEnd(formatDateInput(range.endMs));
  }, [range]);

  const applyRange = (next: TimelineDateRange): void => {
    setStart(formatDateInput(next.startMs));
    setEnd(formatDateInput(next.endMs));
    setError(null);
    onChange(next);
  };

  const applyCustom = (): void => {
    const next = dateRangeFromInputs(start, end);
    if (!next) {
      setError('Choose a valid start date on or before the end date.');
      return;
    }
    applyRange(next);
  };

  return (
    <section className="pg-time-range-bar" aria-label="Timeline date range">
      <span className="pg-time-range-heading">Time range</span>
      <div className="pg-time-range-presets" aria-label="Time range presets">
        <button
          type="button"
          onClick={() => { setError(null); onChange(null); }}
          className={!range ? 'is-active' : ''}
        >
          All time
        </button>
        {[7, 30, 90].map(days => (
          <button key={days} type="button" onClick={() => applyRange(recentDateRange(days))}>
            {days} days
          </button>
        ))}
      </div>
      <span className="pg-time-range-divider" />
      <label>
        From
        <input type="date" value={start} onChange={event => { setStart(event.target.value); setError(null); }} />
      </label>
      <label>
        To
        <input type="date" value={end} onChange={event => { setEnd(event.target.value); setError(null); }} />
      </label>
      <button type="button" className="pg-time-range-apply" onClick={applyCustom}>Apply</button>
      {range && <span className="pg-time-range-current" title={rangeLabel(range)}>{rangeLabel(range)}</span>}
      {error && <span className="pg-time-range-error" role="alert">{error}</span>}
      <button type="button" className="pg-time-range-close" onClick={onClose} aria-label="Close time range filter">×</button>
    </section>
  );
}
