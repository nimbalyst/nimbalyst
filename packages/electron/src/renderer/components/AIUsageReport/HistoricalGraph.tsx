import React, { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface HistoricalGraphProps {
  workspaceId?: string;
}

interface TimeSeriesDataPoint {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  sessionCount: number;
}

export const HistoricalGraph: React.FC<HistoricalGraphProps> = ({ workspaceId }) => {
  const [data, setData] = useState<TimeSeriesDataPoint[]>([]);
  const [timeRange, setTimeRange] = useState<'week' | 'month' | 'quarter' | 'year'>('month');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const now = Date.now();
        const ranges = {
          week: 7 * 24 * 60 * 60 * 1000,
          month: 30 * 24 * 60 * 60 * 1000,
          quarter: 90 * 24 * 60 * 60 * 1000,
          year: 365 * 24 * 60 * 60 * 1000,
        };
        const startDate = now - ranges[timeRange];

        const timeSeries = await window.electronAPI.invoke(
          'usage-analytics:get-time-series',
          startDate,
          now,
          'day',
          workspaceId
        );
        setData(timeSeries);
      } catch (error) {
        console.error('Failed to load time series data:', error);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [timeRange, workspaceId]);

  if (loading) {
    return <div className="historical-graph-loading flex items-center justify-center min-h-[400px] text-nim-muted text-base">Loading...</div>;
  }

  const chartData = data.map((point) => ({
    // Use UTC date formatting since timestamps are truncated to UTC midnight
    date: new Date(point.timestamp).toLocaleDateString(undefined, { timeZone: 'UTC' }),
    'Input Tokens': point.inputTokens,
    'Output Tokens': point.outputTokens,
    Sessions: point.sessionCount,
  }));

  return (
    <div className="historical-graph flex flex-col gap-6">
      <div className="historical-graph-controls flex justify-between items-center">
        <h3 className="m-0 text-lg font-semibold text-nim">Token Usage Over Time</h3>
        <div className="time-range-selector flex gap-1">
          {(['week', 'month', 'quarter', 'year'] as const).map((range) => (
            <button
              key={range}
              className={`px-3.5 py-1.5 border rounded text-[13px] cursor-pointer transition-all duration-200 ${
                timeRange === range
                  ? 'bg-[var(--nim-primary)] text-white border-[var(--nim-primary)]'
                  : 'bg-nim-secondary border-nim text-nim-muted hover:bg-nim-hover hover:text-nim'
              }`}
              onClick={() => setTimeRange(range)}
            >
              {range.charAt(0).toUpperCase() + range.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={400}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--nim-border)" />
            <XAxis dataKey="date" stroke="var(--nim-text-muted)" />
            <YAxis stroke="var(--nim-text-muted)" />
            <Tooltip
              contentStyle={{
                background: 'var(--nim-bg-secondary)',
                border: '1px solid var(--nim-border)',
                borderRadius: '6px',
                color: 'var(--nim-text)',
              }}
            />
            <Legend />
            <Line type="monotone" dataKey="Input Tokens" stroke="#8884d8" strokeWidth={2} />
            <Line type="monotone" dataKey="Output Tokens" stroke="#82ca9d" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="no-data flex items-center justify-center min-h-[400px] text-nim-muted text-base">No data available for this time range</div>
      )}
    </div>
  );
};
