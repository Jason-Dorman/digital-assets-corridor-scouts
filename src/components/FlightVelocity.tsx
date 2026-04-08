'use client';

import useSWR from 'swr';
import type { LFVInterpretation } from '../types';

interface ChainFlight {
  chain: string;
  lfv24h: number;
  interpretation: LFVInterpretation;
  netFlowUsd: number;
  tvlNowUsd: number;
  tvlStartUsd: number;
  poolsMonitored: number;
  alert?: boolean;
}

interface FlightData {
  chains: ChainFlight[];
  updatedAt: string;
}

const INTERP_CONFIG: Record<
  LFVInterpretation,
  { label: string; barColor: string; textColor: string; icon?: string }
> = {
  rapid_flight: {
    label: 'Flight',
    barColor: 'bg-red-500',
    textColor: 'text-red-400',
    icon: '!',
  },
  moderate_outflow: {
    label: 'Outflow',
    barColor: 'bg-amber-500',
    textColor: 'text-amber-400',
  },
  stable: {
    label: 'Stable',
    barColor: 'bg-radar',
    textColor: 'text-radar',
  },
  moderate_inflow: {
    label: 'Inflow',
    barColor: 'bg-blue-400',
    textColor: 'text-blue-400',
  },
  rapid_inflow: {
    label: 'Inflow',
    barColor: 'bg-indigo-400',
    textColor: 'text-indigo-400',
  },
};

const CHAIN_ABBR: Record<string, string> = {
  ethereum: 'ETH',
  arbitrum: 'ARB',
  optimism: 'OP',
  base: 'BASE',
  polygon: 'POLY',
  avalanche: 'AVAX',
};

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '+';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function FlightVelocity(): React.JSX.Element {
  const { data, error, isLoading } = useSWR<FlightData>('/api/flight', {
    refreshInterval: 60_000,
    dedupingInterval: 20_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 animate-pulse">
            <div className="w-12 h-4 bg-ridge/50 rounded flex-shrink-0" />
            <div className="flex-1 h-4 bg-ridge/30 rounded" />
            <div className="w-14 h-4 bg-ridge/50 rounded" />
            <div className="w-16 h-4 bg-ridge/30 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (error || !data || data.chains.length === 0) {
    return (
      <p className="text-sm text-lavender-dim py-2">
        {error ? 'Failed to load flight data.' : 'No chain data available.'}
      </p>
    );
  }

  const maxTvl = Math.max(...data.chains.map(c => c.tvlNowUsd), 1);

  return (
    <div className="space-y-2.5">
      {data.chains.map(chain => {
        const cfg = INTERP_CONFIG[chain.interpretation];
        const barPct = Math.max(2, Math.round((chain.tvlNowUsd / maxTvl) * 100));
        const pctLabel = `${chain.lfv24h >= 0 ? '+' : ''}${(chain.lfv24h * 100).toFixed(1)}%`;

        return (
          <div
            key={chain.chain}
            className="flex items-center gap-1.5 xs:gap-3 group"
            title={`Net flow: ${formatUsd(chain.netFlowUsd)} | TVL: $${(chain.tvlNowUsd / 1_000_000).toFixed(0)}M`}
          >
            {/* Chain abbr */}
            <span className="w-10 xs:w-12 text-[10px] xs:text-xs font-mono text-gold-dim flex-shrink-0 text-right tracking-wider">
              {CHAIN_ABBR[chain.chain] ?? chain.chain.toUpperCase().slice(0, 5)}
            </span>

            {/* Bar */}
            <div className="flex-1 h-3 xs:h-3.5 bg-void-deep rounded overflow-hidden min-w-0 border border-ridge/50">
              <div
                className={`h-full rounded-sm transition-all duration-700 ${cfg.barColor} opacity-80 group-hover:opacity-100`}
                style={{ width: `${barPct}%` }}
              />
            </div>

            {/* LFV % */}
            <span className={`w-12 xs:w-14 text-right text-[10px] xs:text-xs font-mono font-semibold ${cfg.textColor}`}>
              {pctLabel}
            </span>

            {/* Interpretation label — hidden on smallest screens */}
            <span className={`hidden xs:inline w-20 text-xs font-mono ${cfg.textColor} flex-shrink-0`}>
              {cfg.icon && (
                <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-red-500/20 text-red-400 text-[10px] font-bold mr-1">
                  {cfg.icon}
                </span>
              )}
              {cfg.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
