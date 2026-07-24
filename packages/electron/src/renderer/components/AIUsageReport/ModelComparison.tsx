import React, { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface ModelComparisonProps {
  workspaceId?: string;
}

interface ProviderUsageStats {
  provider: string;
  model: string | null;
  sessionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
}

export const ModelComparison: React.FC<ModelComparisonProps> = ({ workspaceId }) => {
  const [data, setData] = useState<ProviderUsageStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const providers = await window.electronAPI.invoke('usage-analytics:get-usage-by-provider', workspaceId);
        setData(providers);
      } catch (error) {
        console.error('Failed to load model comparison data:', error);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [workspaceId]);

  if (loading) {
    return (
      <div className="model-comparison-loading flex items-center justify-center min-h-[400px] text-base text-nim-muted">
        Loading...
      </div>
    );
  }

  const chartData = data.map((item) => ({
    name: `${item.provider}${item.model ? ` (${item.model})` : ''}`,
    'Total Tokens': item.totalTokens,
    Sessions: item.sessionCount,
  }));

  return (
    <div className="model-comparison flex flex-col gap-6">
      <h3 className="m-0 text-lg font-semibold text-nim">Usage by Model</h3>

      {chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={400}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--nim-border)" />
            <XAxis dataKey="name" stroke="var(--nim-text-muted)" />
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
            <Bar dataKey="Total Tokens" fill="var(--nim-primary)" />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div className="no-data flex items-center justify-center min-h-[400px] text-base text-nim-muted">
          No model usage data available
        </div>
      )}
    </div>
  );
};
