import React, { useEffect } from 'react';

// Inject rate limit widget styles once (for color-mix patterns)
const injectRateLimitStyles = () => {
  const styleId = 'rate-limit-widget-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .rate-limit-widget {
      background-color: color-mix(in srgb, var(--nim-warning) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--nim-warning) 25%, transparent);
    }
    .rate-limit-widget-blocked {
      background-color: color-mix(in srgb, var(--nim-error) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--nim-error) 25%, transparent);
    }
  `;
  document.head.appendChild(style);
};

interface RateLimitWidgetProps {
  content: string;
}

/**
 * Parses rate limit info from the HTML comment marker format:
 * <!-- [RATE_LIMIT_WARNING] limitType=5-hour session resetsAtUnix=1772233200 usage=91 -->
 * <!-- [RATE_LIMIT] limitType=5-hour session resetsAtUnix=1772233200 -->
 */
function parseRateLimitInfo(content: string): {
  isWarning: boolean;
  limitType: string;
  resetsAtMs: number | null;
  utilization: number | null;
  model: string | null;
} {
  const isWarning = content.includes('[RATE_LIMIT_WARNING]');
  const limitTypeMatch = content.match(/limitType=([^\s]+(?:\s+[^\s=]+)*?)(?:\s+resetsAtUnix=|\s+usage=|\s*-->)/);
  const resetsAtMatch = content.match(/resetsAtUnix=(\d+)/);
  const utilizationMatch = content.match(/usage=(\d+)/);
  const modelMatch = content.match(/model=([^\s>]+)/);

  return {
    isWarning,
    limitType: limitTypeMatch ? limitTypeMatch[1] : 'usage',
    // Convert Unix seconds to milliseconds for Date math
    resetsAtMs: resetsAtMatch ? parseInt(resetsAtMatch[1], 10) * 1000 : null,
    utilization: utilizationMatch ? parseInt(utilizationMatch[1], 10) : null,
    model: modelMatch ? modelMatch[1] : null,
  };
}

function formatResetTime(resetsAtMs: number): string {
  const diffMs = resetsAtMs - Date.now();

  if (diffMs <= 0) return 'any moment now';

  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMinutes / 60);
  const remainingMinutes = diffMinutes % 60;

  if (diffHours > 0) {
    return `${diffHours}h ${remainingMinutes}m`;
  }
  return `${diffMinutes}m`;
}

export const RateLimitWidget: React.FC<RateLimitWidgetProps> = ({ content }) => {
  useEffect(() => {
    injectRateLimitStyles();
  }, []);

  const { isWarning, limitType, resetsAtMs, utilization, model } = parseRateLimitInfo(content);
  const accentVar = isWarning ? '--nim-warning' : '--nim-error';
  const is1mModel = model != null && model.includes('-1m');

  return (
    <div className={isWarning ? 'rate-limit-widget my-4 p-4 rounded-lg flex flex-col gap-2' : 'rate-limit-widget-blocked my-4 p-4 rounded-lg flex flex-col gap-2'}>
      <div className="flex items-center gap-2">
        <span
          className="flex items-center justify-center w-5 h-5 rounded-full text-white text-xs font-bold"
          style={{ backgroundColor: `var(${accentVar})` }}
        >
          !
        </span>
        <span className="text-sm font-semibold" style={{ color: `var(${accentVar})` }}>
          {isWarning ? 'Approaching rate limit' : 'Rate limit reached'}
        </span>
      </div>
      <div className="text-[var(--nim-text-muted)] text-[0.85rem] leading-relaxed">
        {isWarning
          ? `You're at ${utilization != null ? `${utilization}%` : 'near'} of your ${limitType} limit.`
          : `You've hit your ${limitType} rate limit.`}
        {resetsAtMs && ` Resets in ${formatResetTime(resetsAtMs)}.`}
        {!isWarning && is1mModel && ' This 1M context model may not be available on your plan.'}
      </div>
    </div>
  );
};
