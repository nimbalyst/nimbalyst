import type { TestStatus } from '../types';

const STATUS_COLORS: Record<TestStatus, string> = {
  passed: '#4ade80',
  failed: '#ef4444',
  skipped: '#808080',
  flaky: '#fbbf24',
  running: '#60a5fa',
  pending: '#666666',
};

const STATUS_ICONS: Record<TestStatus, string> = {
  passed: 'check_circle',
  failed: 'cancel',
  skipped: 'remove_circle_outline',
  flaky: 'warning',
  running: 'progress_activity',
  pending: 'radio_button_unchecked',
};

export function StatusIcon({ status, size = 16 }: { status: TestStatus; size?: number }) {
  return (
    <span
      className="material-symbols-outlined"
      style={{
        fontSize: size,
        color: STATUS_COLORS[status],
        animation: status === 'running' ? 'spin 1s linear infinite' : undefined,
        flexShrink: 0,
      }}
    >
      {STATUS_ICONS[status]}
    </span>
  );
}
