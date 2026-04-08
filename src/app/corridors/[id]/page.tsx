'use client';

import { use } from 'react';
import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { StatusIndicator } from '../../../components/StatusIndicator';
import { FragilityBadge } from '../../../components/FragilityBadge';
import type { HealthStatus, FragilityLevel, Severity } from '../../../types';

// ---------------------------------------------------------------------------
// Types — mirrors API response shapes
// ---------------------------------------------------------------------------

interface CorridorMetrics {
  transferCount1h: number;
  transferCount24h: number;
  successRate1h: number | null;
  successRate24h: number | null;
  p50DurationSeconds: number | null;
  p90DurationSeconds: number | null;
  volumeUsd24h: number;
}

interface CorridorPool {
  tvlUsd: number;
  utilization: number;
  availableLiquidity: number;
  fragility: FragilityLevel;
  fragilityReason: string;
}

interface Corridor {
  corridorId: string;
  bridge: string;
  sourceChain: string;
  destChain: string;
  status: HealthStatus;
  metrics: CorridorMetrics;
  pool: CorridorPool;
  lastTransferAt: string | null;
}

interface Transfer {
  transferId: string;
  amount: string;
  amountUsd: number | null;
  asset: string;
  status: string;
  initiatedAt: string;
  completedAt: string | null;
  durationSeconds: number | null;
  txHashSource: string | null;
  txHashDest: string | null;
}

interface HourlyStat {
  hour: string;
  transferCount: number;
  successRate: number | null;
  p50DurationSeconds: number | null;
  p90DurationSeconds: number | null;
  volumeUsd: number;
}

interface DailyStat {
  date: string;
  transferCount: number;
  successRate: number | null;
  avgDurationSeconds: number | null;
  volumeUsd: number;
  status: HealthStatus;
}

interface CorridorDetailData {
  corridor: Corridor;
  recentTransfers: Transfer[];
  hourlyStats: HourlyStat[];
  dailyStats: DailyStat[];
  anomalies: unknown[];
}

interface Anomaly {
  id: string;
  anomalyType: string;
  corridorId: string;
  bridge: string;
  sourceChain: string | null;
  destChain: string | null;
  severity: Severity;
  detectedAt: string;
  resolvedAt: string | null;
  description: string;
}

interface AnomaliesData {
  anomalies: Anomaly[];
  total: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STUCK_THRESHOLDS_SECONDS: Record<string, number> = {
  across: 1800,
  cctp: 2700,
  stargate: 1800,
};

const CHAIN_LABEL: Record<string, string> = {
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  base: 'Base',
  polygon: 'Polygon',
  avalanche: 'Avalanche',
};

const BRIDGE_LABEL: Record<string, string> = {
  across: 'Across',
  cctp: 'CCTP',
  stargate: 'Stargate',
};

const SEVERITY_DOT: Record<Severity, string> = {
  high: 'bg-red-500 shadow-glow-red',
  medium: 'bg-amber-400',
  low: 'bg-lavender-dim',
};

const SEVERITY_BORDER: Record<Severity, string> = {
  high: 'border-l-red-500',
  medium: 'border-l-amber-500',
  low: 'border-l-ridge-bright',
};

const SEVERITY_LABEL: Record<Severity, string> = {
  high: 'CRIT',
  medium: 'WARN',
  low: 'INFO',
};

const SEVERITY_LABEL_COLOR: Record<Severity, string> = {
  high: 'text-red-400',
  medium: 'text-amber-400',
  low: 'text-lavender-dim',
};

const STATUS_COLOR: Record<string, string> = {
  completed: 'text-radar',
  pending: 'text-amber-400',
  stuck: 'text-red-400',
  failed: 'text-red-500',
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '--';
  if (seconds < 60) return `${seconds}s`;
  const mins = seconds / 60;
  return `${mins % 1 === 0 ? mins.toFixed(0) : mins.toFixed(1)}m`;
}

function formatUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function timeAgo(isoDate: string): string {
  const seconds = Math.round((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function formatHour(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function truncateHash(hash: string | null): string {
  if (!hash) return '--';
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Health explanation — surfaces the problem, not a stat dump
// ---------------------------------------------------------------------------

function buildHealthExplanation(
  status: HealthStatus,
  metrics: CorridorMetrics,
): string {
  const sr1h = metrics.successRate1h;
  const sr24h = metrics.successRate24h;
  const p50 = metrics.p50DurationSeconds;
  const count1h = metrics.transferCount1h;

  if (status === 'down') {
    if (count1h === 0) return 'No transfers in the last hour';
    if (sr1h !== null && sr1h < 95) {
      const failRate = (100 - sr1h).toFixed(1);
      return `${failRate}% failure rate in last hour`;
    }
    return 'Latency exceeds 5x normal';
  }

  if (status === 'degraded') {
    if (sr1h !== null && sr1h < 99) {
      return `${sr1h.toFixed(1)}% success rate in last hour`;
    }
    return 'Latency 2-5x above normal';
  }

  // Healthy — show the good stats
  const srText = sr24h !== null ? `${sr24h.toFixed(1)}% success rate` : 'No resolved transfers';
  const p50Text = p50 !== null ? `${formatDuration(p50)} median settlement` : '';
  return [srText, p50Text].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// Section components (inline — page-specific, not reused)
// ---------------------------------------------------------------------------

/** FR-6.1: Corridor identification + FR-6.2: Health with explanation */
function CorridorHeader({ corridor }: { corridor: Corridor }): React.JSX.Element {
  const explanation = buildHealthExplanation(corridor.status, corridor.metrics);

  return (
    <div className="space-y-3">
      {/* Back link */}
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-xs font-mono text-lavender-dim hover:text-gold transition-colors tracking-wider uppercase"
      >
        <span aria-hidden="true">&larr;</span> Dashboard
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
        {/* Bridge + route */}
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold tracking-wide text-gold-text font-mono">
            {BRIDGE_LABEL[corridor.bridge] ?? corridor.bridge}
          </h1>
          <span className="text-sm font-mono text-lavender">
            {CHAIN_LABEL[corridor.sourceChain] ?? corridor.sourceChain}
            <span className="text-ridge-bright mx-1.5">&rarr;</span>
            {CHAIN_LABEL[corridor.destChain] ?? corridor.destChain}
          </span>
        </div>

        {/* Health status + explanation */}
        <div className="flex items-center gap-2">
          <StatusIndicator status={corridor.status} size="md" />
          <span className={`text-sm font-mono ${
            corridor.status === 'healthy' ? 'text-radar' :
            corridor.status === 'degraded' ? 'text-amber-400' :
            'text-red-400'
          }`}>
            {corridor.status === 'healthy' ? 'Healthy' :
             corridor.status === 'degraded' ? 'Degraded' :
             'Down'}
          </span>
          <span className="text-xs text-lavender-dim font-mono hidden sm:inline">
            — {explanation}
          </span>
        </div>
      </div>
      {/* Explanation on mobile (separate line) */}
      <p className="text-xs text-lavender-dim font-mono sm:hidden">
        {explanation}
      </p>
    </div>
  );
}

/** FR-6.3: 24h transfer count and success rate + FR-6.5: Pool metrics */
function MetricsGrid({ corridor }: { corridor: Corridor }): React.JSX.Element {
  const { metrics, pool } = corridor;

  const stats = [
    {
      label: 'Transfers (24h)',
      value: metrics.transferCount24h.toLocaleString(),
      accent: 'text-gold-bright',
    },
    {
      label: 'Success Rate (24h)',
      value: metrics.successRate24h !== null ? `${metrics.successRate24h.toFixed(1)}%` : '--',
      accent: metrics.successRate24h !== null && metrics.successRate24h < 99
        ? 'text-amber-400'
        : 'text-radar',
    },
    {
      label: 'p50 Settlement',
      value: formatDuration(metrics.p50DurationSeconds),
      accent: 'text-radar',
    },
    {
      label: 'p90 Settlement',
      value: formatDuration(metrics.p90DurationSeconds),
      accent: 'text-radar',
    },
    {
      label: 'Volume (24h)',
      value: formatUsd(metrics.volumeUsd24h),
      accent: 'text-gold-bright',
    },
    {
      label: 'TVL',
      value: formatUsd(pool.tvlUsd),
      accent: 'text-gold-bright',
    },
    {
      label: 'Utilization',
      value: `${pool.utilization}%`,
      accent: pool.utilization > 60 ? 'text-red-400' : pool.utilization > 30 ? 'text-amber-400' : 'text-radar',
    },
    {
      label: 'Fragility',
      value: null, // rendered as badge
      accent: '',
      badge: pool.fragility,
      reason: pool.fragilityReason,
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {stats.map(stat => (
        <div key={stat.label} className="card-radar p-3 text-center" title={stat.reason}>
          <div className={`text-xl sm:text-2xl font-mono font-bold tabular-nums ${stat.accent}`}>
            {stat.badge !== undefined
              ? <FragilityBadge level={stat.badge} />
              : stat.value}
          </div>
          <div className="mt-1 text-[10px] text-lavender-dim uppercase tracking-wider font-mono">
            {stat.label}
          </div>
        </div>
      ))}
    </div>
  );
}

/** FR-6.4: Settlement time chart (time series p50/p90 over 24h) */
function SettlementChart({
  hourlyStats,
  bridge,
}: {
  hourlyStats: HourlyStat[];
  bridge: string;
}): React.JSX.Element {
  const stuckThreshold = STUCK_THRESHOLDS_SECONDS[bridge] ?? 1800;

  // Convert seconds to minutes for display
  const chartData = hourlyStats.map(h => ({
    hour: formatHour(h.hour),
    p50: h.p50DurationSeconds !== null ? h.p50DurationSeconds / 60 : null,
    p90: h.p90DurationSeconds !== null ? h.p90DurationSeconds / 60 : null,
  }));

  const stuckMinutes = stuckThreshold / 60;

  // Determine Y-axis max — include stuck line only if data approaches it
  const allValues = chartData.flatMap(d => [d.p50, d.p90]).filter((v): v is number => v !== null);
  const maxValue = allValues.length > 0 ? Math.max(...allValues) : 10;
  const showStuckLine = maxValue > stuckMinutes * 0.3;

  return (
    <div>
      <h2 className="section-heading mb-3">Settlement Time (24h)</h2>
      <div className="card-radar p-4">
        {allValues.length === 0 ? (
          <p className="text-sm text-lavender-dim font-mono py-8 text-center">
            No settlement data for this period.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2045" />
              <XAxis
                dataKey="hour"
                tick={{ fill: '#6e5f8f', fontSize: 10, fontFamily: 'monospace' }}
                axisLine={{ stroke: '#2a2045' }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: '#6e5f8f', fontSize: 10, fontFamily: 'monospace' }}
                axisLine={{ stroke: '#2a2045' }}
                tickLine={false}
                tickFormatter={v => `${v}m`}
                width={40}
              />
              <RechartsTooltip
                contentStyle={{
                  backgroundColor: '#151029',
                  border: '1px solid #2a2045',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                }}
                labelStyle={{ color: '#9f8fc7' }}
                formatter={(value: number) => [`${value.toFixed(1)}m`, '']}
              />
              {showStuckLine && (
                <ReferenceLine
                  y={stuckMinutes}
                  stroke="#ef4444"
                  strokeDasharray="6 4"
                  strokeOpacity={0.5}
                  label={{
                    value: 'Stuck threshold',
                    position: 'insideTopRight',
                    fill: '#ef4444',
                    fontSize: 10,
                    fontFamily: 'monospace',
                  }}
                />
              )}
              <Line
                type="monotone"
                dataKey="p50"
                stroke="#00cfe8"
                strokeWidth={2}
                dot={false}
                name="p50"
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="p90"
                stroke="#c9a227"
                strokeWidth={2}
                dot={false}
                name="p90"
                strokeDasharray="4 2"
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}

        {/* Legend */}
        <div className="flex items-center gap-4 mt-2 justify-center text-[10px] font-mono text-lavender-dim">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-0.5 bg-radar" /> p50 (median)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-0.5 bg-gold" style={{ borderTop: '2px dashed #c9a227', background: 'none' }} /> p90
          </span>
          {showStuckLine && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-0.5" style={{ borderTop: '2px dashed #ef4444' }} /> stuck
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** FR-6.8: Historical health trend (7 days) — colored dots with hover tooltip */
function HealthTrend({ dailyStats }: { dailyStats: DailyStat[] }): React.JSX.Element {
  const [hoveredDay, setHoveredDay] = useState<DailyStat | null>(null);

  return (
    <div>
      <h2 className="section-heading mb-3">Health Trend (7d)</h2>
      <div className="card-radar p-4">
        <div className="flex items-center justify-center gap-3 sm:gap-4">
          {dailyStats.map(day => (
            <div
              key={day.date}
              className="flex flex-col items-center gap-1.5 cursor-default"
              onMouseEnter={() => setHoveredDay(day)}
              onMouseLeave={() => setHoveredDay(null)}
            >
              <StatusIndicator status={day.status} size="lg" />
              <span className="text-[10px] font-mono text-lavender-dim">
                {formatDate(day.date)}
              </span>
            </div>
          ))}
        </div>

        {/* Tooltip for hovered day */}
        <div className={`mt-3 text-center text-xs font-mono transition-opacity duration-150 ${
          hoveredDay ? 'opacity-100' : 'opacity-0'
        }`}>
          {hoveredDay && (
            <span className="text-lavender">
              {formatDate(hoveredDay.date)}:{' '}
              <span className="text-radar">
                {hoveredDay.successRate !== null ? `${hoveredDay.successRate.toFixed(1)}% success` : 'No data'}
              </span>
              {hoveredDay.avgDurationSeconds !== null && (
                <>
                  {' · '}
                  <span className="text-gold">{formatDuration(hoveredDay.avgDurationSeconds)} avg</span>
                </>
              )}
              {' · '}
              <span className="text-lavender-dim">{hoveredDay.transferCount} transfers</span>
            </span>
          )}
          {/* Invisible placeholder to prevent layout shift */}
          {!hoveredDay && <span className="invisible">placeholder</span>}
        </div>
      </div>
    </div>
  );
}

/** FR-6.6: Recent transfers table (last 20) */
function RecentTransfers({ transfers }: { transfers: Transfer[] }): React.JSX.Element {
  return (
    <div>
      <h2 className="section-heading mb-3">Recent Transfers</h2>
      <div className="overflow-x-auto rounded-lg border border-ridge">
        <table className="w-full min-w-[480px] text-sm" role="grid">
          <thead className="bg-void-card border-b border-ridge">
            <tr>
              <th className="px-3 py-3 text-left text-[10px] font-mono font-medium uppercase tracking-[0.15em] text-lavender-dim">
                Asset
              </th>
              <th className="px-3 py-3 text-right text-[10px] font-mono font-medium uppercase tracking-[0.15em] text-lavender-dim">
                Amount
              </th>
              <th className="px-3 py-3 text-center text-[10px] font-mono font-medium uppercase tracking-[0.15em] text-lavender-dim">
                Status
              </th>
              <th className="px-3 py-3 text-right text-[10px] font-mono font-medium uppercase tracking-[0.15em] text-lavender-dim hidden sm:table-cell">
                Duration
              </th>
              <th className="px-3 py-3 text-right text-[10px] font-mono font-medium uppercase tracking-[0.15em] text-lavender-dim hidden sm:table-cell">
                Time
              </th>
              <th className="px-3 py-3 text-right text-[10px] font-mono font-medium uppercase tracking-[0.15em] text-lavender-dim hidden md:table-cell">
                Tx
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ridge/50">
            {transfers.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-lavender-dim font-mono">
                  No recent transfers.
                </td>
              </tr>
            )}
            {transfers.map(tx => (
              <tr key={tx.transferId} className="bg-void-deep hover:bg-void-hover transition-colors">
                <td className="px-3 py-2.5 font-mono text-xs text-gold-text">{tx.asset}</td>
                <td className="px-3 py-2.5 text-right font-mono text-xs text-lavender tabular-nums">
                  {tx.amountUsd !== null ? formatUsd(tx.amountUsd) : tx.amount}
                </td>
                <td className="px-3 py-2.5 text-center">
                  <span className={`text-xs font-mono font-medium ${STATUS_COLOR[tx.status] ?? 'text-lavender-dim'}`}>
                    {tx.status}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-xs text-radar tabular-nums hidden sm:table-cell">
                  {formatDuration(tx.durationSeconds)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-xs text-lavender-dim hidden sm:table-cell">
                  {timeAgo(tx.initiatedAt)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-xs text-lavender-dim hidden md:table-cell">
                  {truncateHash(tx.txHashSource)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** FR-6.7: Active anomalies for this corridor */
function CorridorAnomalies({
  anomalies,
  isLoading,
  error,
}: {
  anomalies: Anomaly[];
  isLoading: boolean;
  error: Error | undefined;
}): React.JSX.Element {
  return (
    <div>
      <h2 className="section-heading mb-3">Active Anomalies</h2>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-12 card-radar animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && error && (
        <p className="text-sm text-lavender-dim font-mono py-2">Failed to load anomalies.</p>
      )}

      {!isLoading && !error && anomalies.length === 0 && (
        <div className="card-radar p-4 flex items-center gap-3">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inset-0 rounded-full bg-radar/40 radar-ping" />
            <span className="relative inline-block h-2.5 w-2.5 rounded-full bg-radar" />
          </span>
          <span className="text-sm text-radar font-mono">
            No active anomalies
          </span>
        </div>
      )}

      {!isLoading && !error && anomalies.length > 0 && (
        <div className="space-y-2">
          {anomalies.map(anomaly => (
            <div
              key={anomaly.id}
              className={`flex items-start gap-3 p-3 card-radar border-l-2 ${SEVERITY_BORDER[anomaly.severity]} min-w-0`}
            >
              {/* Severity dot + label */}
              <div className="flex flex-col items-center gap-1 flex-shrink-0 pt-0.5">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${SEVERITY_DOT[anomaly.severity]}`}
                  aria-label={`${anomaly.severity} severity`}
                />
                <span className={`text-[9px] font-mono font-bold tracking-wider ${SEVERITY_LABEL_COLOR[anomaly.severity]}`}>
                  {SEVERITY_LABEL[anomaly.severity]}
                </span>
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-lavender">{anomaly.description}</p>
                <p className="text-xs text-lavender-dim font-mono mt-0.5">{timeAgo(anomaly.detectedAt)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function DetailSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Header skeleton */}
      <div className="space-y-3">
        <div className="h-3 bg-ridge/30 rounded w-20" />
        <div className="h-6 bg-ridge/30 rounded w-64" />
      </div>

      {/* Metrics grid skeleton */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="card-radar p-3">
            <div className="h-7 bg-ridge/30 rounded w-1/2 mx-auto mb-2" />
            <div className="h-2 bg-ridge/20 rounded w-3/4 mx-auto" />
          </div>
        ))}
      </div>

      {/* Chart skeleton */}
      <div className="card-radar p-4">
        <div className="h-60 bg-ridge/20 rounded" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function CorridorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);

  // Parallel SWR hooks — corridor data + anomalies at different refresh rates
  const {
    data: detailData,
    error: detailError,
    isLoading: detailLoading,
  } = useSWR<CorridorDetailData>(`/api/corridors/${id}`, {
    refreshInterval: 30_000,
    dedupingInterval: 10_000,
  });

  const {
    data: anomalyData,
    error: anomalyError,
    isLoading: anomalyLoading,
  } = useSWR<AnomaliesData>(`/api/anomalies?corridorId=${id}&active=true`, {
    refreshInterval: 15_000,
    dedupingInterval: 5_000,
  });

  return (
    <div className="min-h-screen bg-void-deep radar-grid">
      {/* Header bar — matches dashboard */}
      <header className="sticky top-0 z-20 border-b border-ridge bg-void/95 backdrop-blur-md gold-accent-top">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-14 items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative h-7 w-7 flex items-center justify-center">
                <div className="absolute inset-0 rounded-full border border-gold/30" />
                <div className="absolute inset-1 rounded-full border border-gold/20" />
                <div className="h-1.5 w-1.5 rounded-full bg-gold animate-glow" />
              </div>
              <Link
                href="/"
                className="text-sm font-bold tracking-[0.25em] text-gold-text uppercase hover:text-gold-bright transition-colors"
              >
                Corridor Scout
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Loading state */}
        {detailLoading && <DetailSkeleton />}

        {/* Error state */}
        {!detailLoading && detailError && (
          <div className="space-y-3">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-xs font-mono text-lavender-dim hover:text-gold transition-colors tracking-wider uppercase"
            >
              <span aria-hidden="true">&larr;</span> Dashboard
            </Link>
            <div className="card-radar p-6 text-center">
              <p className="text-sm text-red-400 font-mono">
                Failed to load corridor data.
              </p>
              <p className="text-xs text-lavender-dim font-mono mt-1">
                Corridor ID: {id}
              </p>
            </div>
          </div>
        )}

        {/* Loaded state */}
        {!detailLoading && !detailError && detailData && (
          <>
            {/* FR-6.1 + FR-6.2: Identification + Health */}
            <section aria-labelledby="corridor-heading">
              <h2 id="corridor-heading" className="sr-only">Corridor Overview</h2>
              <CorridorHeader corridor={detailData.corridor} />
            </section>

            {/* FR-6.3 + FR-6.5: Transfer stats + Pool metrics */}
            <section aria-labelledby="metrics-heading">
              <h2 id="metrics-heading" className="sr-only">Metrics</h2>
              <MetricsGrid corridor={detailData.corridor} />
            </section>

            {/* FR-6.4: Settlement time chart */}
            <section aria-labelledby="settlement-heading">
              <h2 id="settlement-heading" className="sr-only">Settlement Time</h2>
              <SettlementChart
                hourlyStats={detailData.hourlyStats}
                bridge={detailData.corridor.bridge}
              />
            </section>

            {/* FR-6.8: Historical health trend */}
            <section aria-labelledby="trend-heading">
              <h2 id="trend-heading" className="sr-only">Health Trend</h2>
              <HealthTrend dailyStats={detailData.dailyStats} />
            </section>

            {/* FR-6.7: Active anomalies */}
            <section aria-labelledby="anomalies-heading">
              <h2 id="anomalies-heading" className="sr-only">Anomalies</h2>
              <CorridorAnomalies
                anomalies={anomalyData?.anomalies ?? []}
                isLoading={anomalyLoading}
                error={anomalyError}
              />
            </section>

            {/* FR-6.6: Recent transfers */}
            <section aria-labelledby="transfers-heading">
              <h2 id="transfers-heading" className="sr-only">Recent Transfers</h2>
              <RecentTransfers transfers={detailData.recentTransfers} />
            </section>
          </>
        )}
      </main>

      {/* Footer accent line */}
      <div className="h-px bg-gradient-to-r from-transparent via-ridge-bright to-transparent" />
    </div>
  );
}
