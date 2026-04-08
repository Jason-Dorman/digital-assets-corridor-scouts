'use client';

import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import type { Severity } from '../types';

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

function timeAgo(isoDate: string): string {
  const seconds = Math.round((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function AlertList(): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  const { data, error, isLoading } = useSWR<AnomaliesData>('/api/anomalies?active=true&limit=10', {
    refreshInterval: 15_000,
    dedupingInterval: 5_000,
  });

  const visible = expanded
    ? (data?.anomalies ?? [])
    : (data?.anomalies ?? []).slice(0, 5);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-12 card-radar animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-lavender-dim py-2">Failed to load alerts.</p>
    );
  }

  if (!data || data.anomalies.length === 0) {
    return (
      <div className="card-radar p-4 flex items-center gap-3">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inset-0 rounded-full bg-radar/40 radar-ping" />
          <span className="relative inline-block h-2.5 w-2.5 rounded-full bg-radar" />
        </span>
        <span className="text-sm text-radar font-mono">
          All corridors operating normally
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {visible.map(anomaly => (
        <Link
          key={anomaly.id}
          href={`/corridors/${anomaly.corridorId}`}
          className={`flex items-start gap-2 xs:gap-3 p-2.5 xs:p-3 card-radar border-l-2 ${SEVERITY_BORDER[anomaly.severity]} hover:border-ridge-bright min-w-0 min-h-[44px]`}
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
            <p className="text-sm text-lavender truncate">{anomaly.description}</p>
            <p className="text-xs text-lavender-dim font-mono mt-0.5">{timeAgo(anomaly.detectedAt)}</p>
          </div>

          {/* Arrow */}
          <span className="text-ridge-bright flex-shrink-0 text-sm mt-0.5 font-mono" aria-hidden="true">
            &rsaquo;
          </span>
        </Link>
      ))}

      {(data?.anomalies.length ?? 0) > 5 && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="w-full text-xs font-mono text-gold-dim hover:text-gold transition-colors py-2.5 min-h-[44px] text-center tracking-wider uppercase"
          type="button"
        >
          {expanded
            ? '[ Show fewer ]'
            : `[ Show ${data.anomalies.length - 5} more ]`}
        </button>
      )}
    </div>
  );
}
