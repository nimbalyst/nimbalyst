import React from 'react';
import { formatResetTime } from '../../store/atoms/ollamaUsageAtoms';

interface CostPeriodSectionProps {
  costPeriod: { type: string; startingAt: string; endingAt: string };
  costUSD?: number;
}

/** Only API-provided cost-period bounds establish elapsed time; observation time never does. */
export const CostPeriodSection: React.FC<CostPeriodSectionProps> = ({ costPeriod, costUSD }) => {
  const start = Date.parse(costPeriod.startingAt);
  const end = Date.parse(costPeriod.endingAt);
  const now = Date.now();
  const valid = Number.isFinite(start) && Number.isFinite(end) && end > start;
  const elapsed = valid ? Math.round(Math.max(0, Math.min(1, (now - start) / (end - start))) * 100) : null;
  return (
    <div className="mb-4 last:mb-0">
      <div className="flex justify-between items-baseline mb-1">
        <div className="text-[13px] font-semibold text-nim">Cost Period</div>
        {costUSD !== undefined && <div className="text-[16px] font-semibold text-nim-muted">${costUSD.toFixed(5)}</div>}
      </div>
      {elapsed !== null && <div role="progressbar" aria-label="Cost period elapsed" aria-valuemin={0} aria-valuemax={100} aria-valuenow={elapsed}
        className="relative h-1.5 bg-nim-tertiary rounded-full overflow-hidden mb-1.5">
        <div className="h-full rounded-full bg-nim-muted" style={{ width: `${elapsed}%` }} />
      </div>}
      {valid && <div className="text-[11px] text-nim-muted">
        {end <= now ? 'Cost period ended' : `Cost period ends in ${formatResetTime(costPeriod.endingAt)}`}
      </div>}
    </div>
  );
};
