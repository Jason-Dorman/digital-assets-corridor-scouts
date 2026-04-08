'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { StatusIndicator } from './StatusIndicator';
import { FragilityBadge } from './FragilityBadge';
import type { HealthStatus, FragilityLevel } from '../types';

interface CorridorMetrics {
  transferCount24h: number;
  successRate24h: number | null;
  p50DurationSeconds: number | null;
  p90DurationSeconds: number | null;
}

interface CorridorPool {
  tvlUsd: number | null;
  utilization: number | null;
  fragility: FragilityLevel;
  fragilityReason?: string;
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

interface CorridorsData {
  corridors: Corridor[];
  total: number;
}

type SortField = 'p50' | 'p90' | 'transfers' | 'fragility';
type SortOrder = 'asc' | 'desc';

const CHAIN_ABBR: Record<string, string> = {
  ethereum: 'ETH',
  arbitrum: 'ARB',
  optimism: 'OP',
  base: 'BASE',
  polygon: 'POLY',
  avalanche: 'AVAX',
};

const BRIDGE_CHAINS: Record<string, string[]> = {
  across: ['ethereum', 'arbitrum', 'optimism', 'base', 'polygon'],
  cctp: ['ethereum', 'arbitrum', 'optimism', 'base', 'avalanche'],
  stargate: ['ethereum', 'arbitrum', 'optimism', 'avalanche', 'polygon'],
};

const ALL_CHAINS = ['ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'avalanche'];

const CHAIN_LABEL: Record<string, string> = {
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  base: 'Base',
  polygon: 'Polygon',
  avalanche: 'Avalanche',
};

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '--';
  if (seconds < 60) return `${seconds}s`;
  const mins = seconds / 60;
  return `${mins % 1 === 0 ? mins.toFixed(0) : mins.toFixed(1)}m`;
}

const filterSelectClasses =
  'bg-void-deep border border-ridge rounded px-2 py-2 text-xs text-lavender font-mono focus:outline-none focus:ring-1 focus:ring-gold/40 focus:border-gold/40 min-w-0 xs:min-w-[80px] min-h-[44px] transition-colors';

interface ThProps {
  label: string;
  field?: SortField;
  currentSort: SortField;
  currentOrder: SortOrder;
  onSort: (f: SortField) => void;
  className?: string;
  hideOnMobile?: boolean;
}

function Th({ label, field, currentSort, currentOrder, onSort, className = '', hideOnMobile }: ThProps): React.JSX.Element {
  const active = field && currentSort === field;
  const arrow = active ? (currentOrder === 'asc' ? ' \u2191' : ' \u2193') : '';
  const base = `px-2 xs:px-3 py-2.5 xs:py-3 text-left text-[10px] font-mono font-medium uppercase tracking-[0.15em] select-none ${className}`;
  const mobile = hideOnMobile ? 'hidden sm:table-cell' : '';
  const color = active ? 'text-gold' : 'text-lavender-dim';

  if (!field) {
    return <th className={`${base} ${mobile} ${color}`}>{label}</th>;
  }

  return (
    <th
      className={`${base} ${mobile} ${color} cursor-pointer hover:text-gold-bright transition-colors`}
      onClick={() => onSort(field)}
      aria-sort={active ? (currentOrder === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}{arrow}
    </th>
  );
}

export function CorridorTable(): React.JSX.Element {
  const [sort, setSort] = useState<SortField>('p50');
  const [order, setOrder] = useState<SortOrder>('asc');
  const [filterBridge, setFilterBridge] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [filterDest, setFilterDest] = useState('');

  const buildUrl = useCallback((): string => {
    const params = new URLSearchParams({ sort, order, limit: '100' });
    if (filterBridge) params.set('bridge', filterBridge);
    if (filterSource) params.set('source', filterSource);
    if (filterDest) params.set('dest', filterDest);
    return `/api/corridors?${params.toString()}`;
  }, [sort, order, filterBridge, filterSource, filterDest]);

  const { data, error, isLoading } = useSWR<CorridorsData>(buildUrl(), {
    refreshInterval: 30_000,
    dedupingInterval: 10_000,
  });

  const handleSort = useCallback((field: SortField) => {
    if (sort === field) {
      setOrder(o => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(field);
      setOrder('asc');
    }
  }, [sort]);

  const sourceOptions = filterBridge ? (BRIDGE_CHAINS[filterBridge] ?? ALL_CHAINS) : ALL_CHAINS;
  const destOptions = filterBridge ? (BRIDGE_CHAINS[filterBridge] ?? ALL_CHAINS) : ALL_CHAINS;

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="grid grid-cols-3 xs:flex xs:flex-wrap gap-2">
        <select
          value={filterBridge}
          onChange={e => { setFilterBridge(e.target.value); setFilterSource(''); setFilterDest(''); }}
          className={filterSelectClasses}
          aria-label="Filter by bridge"
        >
          <option value="">All bridges</option>
          <option value="across">Across</option>
          <option value="cctp">CCTP</option>
          <option value="stargate">Stargate</option>
        </select>

        <select
          value={filterSource}
          onChange={e => setFilterSource(e.target.value)}
          className={filterSelectClasses}
          aria-label="Filter by source chain"
        >
          <option value="">All sources</option>
          {sourceOptions.map(c => (
            <option key={c} value={c}>{CHAIN_LABEL[c] ?? c}</option>
          ))}
        </select>

        <select
          value={filterDest}
          onChange={e => setFilterDest(e.target.value)}
          className={filterSelectClasses}
          aria-label="Filter by destination chain"
        >
          <option value="">All destinations</option>
          {destOptions.map(c => (
            <option key={c} value={c}>{CHAIN_LABEL[c] ?? c}</option>
          ))}
        </select>

        {(filterBridge || filterSource || filterDest) && (
          <button
            type="button"
            onClick={() => { setFilterBridge(''); setFilterSource(''); setFilterDest(''); }}
            className="text-xs font-mono text-gold-dim hover:text-gold transition-colors px-2 py-2 min-h-[44px] tracking-wider uppercase"
          >
            [ Clear ]
          </button>
        )}

        {data && (
          <span className="col-span-3 xs:col-span-1 text-xs text-lavender-dim font-mono xs:ml-auto self-center text-center xs:text-right">
            {data.total} corridor{data.total !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-ridge">
        <table className="w-full min-w-[320px] text-sm" role="grid">
          <thead className="bg-void-card border-b border-ridge">
            <tr>
              <Th label="Bridge" currentSort={sort} currentOrder={order} onSort={handleSort} />
              <Th label="Route" currentSort={sort} currentOrder={order} onSort={handleSort} />
              <Th label="Health" currentSort={sort} currentOrder={order} onSort={handleSort} className="text-center" />
              <Th label="p50" field="p50" currentSort={sort} currentOrder={order} onSort={handleSort} className="text-right" />
              <Th label="p90" field="p90" currentSort={sort} currentOrder={order} onSort={handleSort} className="text-right" hideOnMobile />
              <Th label="Fragility" field="fragility" currentSort={sort} currentOrder={order} onSort={handleSort} hideOnMobile />
            </tr>
          </thead>
          <tbody className="divide-y divide-ridge/50">
            {isLoading &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  {Array.from({ length: 6 }).map((__, j) => (
                    <td key={j} className="px-3 py-3">
                      <div className="h-3 bg-ridge/30 rounded w-3/4" />
                    </td>
                  ))}
                </tr>
              ))}

            {!isLoading && error && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-lavender-dim font-mono">
                  Failed to load corridors.
                </td>
              </tr>
            )}

            {!isLoading && !error && data?.corridors.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-lavender-dim font-mono">
                  No corridors match the current filters.
                </td>
              </tr>
            )}

            {!isLoading &&
              !error &&
              data?.corridors.map(corridor => (
                <tr
                  key={corridor.corridorId}
                  className="bg-void-deep hover:bg-void-hover transition-colors cursor-pointer min-h-[44px]"
                  onClick={() => { window.location.href = `/corridors/${corridor.corridorId}`; }}
                  role="row"
                >
                  {/* Bridge */}
                  <td className="px-2 xs:px-3 py-2.5 xs:py-3 font-mono font-medium text-gold-text whitespace-nowrap text-xs tracking-wider">
                    <Link
                      href={`/corridors/${corridor.corridorId}`}
                      className="hover:text-gold-bright focus:outline-none focus:underline"
                      onClick={e => e.stopPropagation()}
                    >
                      {corridor.bridge === 'cctp' ? 'CCTP' : corridor.bridge.charAt(0).toUpperCase() + corridor.bridge.slice(1)}
                    </Link>
                  </td>

                  {/* Route */}
                  <td className="px-2 xs:px-3 py-2.5 xs:py-3 text-lavender whitespace-nowrap font-mono text-xs">
                    {CHAIN_ABBR[corridor.sourceChain] ?? corridor.sourceChain}
                    <span className="text-ridge-bright mx-1 xs:mx-1.5">&rarr;</span>
                    {CHAIN_ABBR[corridor.destChain] ?? corridor.destChain}
                  </td>

                  {/* Health */}
                  <td className="px-2 xs:px-3 py-2.5 xs:py-3 text-center">
                    <StatusIndicator status={corridor.status} size="sm" />
                  </td>

                  {/* p50 */}
                  <td className="px-2 xs:px-3 py-2.5 xs:py-3 text-right font-mono text-xs text-radar">
                    {formatDuration(corridor.metrics.p50DurationSeconds)}
                  </td>

                  {/* p90 */}
                  <td className="px-2 xs:px-3 py-2.5 xs:py-3 text-right font-mono text-xs text-radar hidden sm:table-cell">
                    {formatDuration(corridor.metrics.p90DurationSeconds)}
                  </td>

                  {/* Fragility */}
                  <td className="px-2 xs:px-3 py-2.5 xs:py-3 hidden sm:table-cell" title={corridor.pool.fragilityReason}>
                    <FragilityBadge level={corridor.pool.fragility} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
