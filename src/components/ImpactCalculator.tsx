'use client';

import { useState, useCallback, useMemo } from 'react';
import type { ImpactLevel, FragilityLevel, HealthStatus } from '../types';
import { StatusIndicator } from './StatusIndicator';
import { FragilityBadge } from './FragilityBadge';

// Chains per bridge (mirrors src/lib/constants.ts BRIDGE_CHAINS)
const BRIDGE_CHAINS: Record<string, string[]> = {
  across: ['ethereum', 'arbitrum', 'optimism', 'base', 'polygon'],
  cctp: ['ethereum', 'arbitrum', 'optimism', 'base', 'avalanche'],
  stargate: ['ethereum', 'arbitrum', 'optimism', 'avalanche', 'polygon'],
};

const CHAIN_LABEL: Record<string, string> = {
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  base: 'Base',
  polygon: 'Polygon',
  avalanche: 'Avalanche',
};

const IMPACT_STYLE: Record<ImpactLevel, { badge: string; text: string }> = {
  negligible: { badge: 'bg-radar/10 text-radar ring-radar/30', text: 'text-radar' },
  low: { badge: 'bg-radar/10 text-radar ring-radar/30', text: 'text-radar' },
  moderate: { badge: 'bg-amber-500/10 text-amber-300 ring-amber-500/30', text: 'text-amber-400' },
  high: { badge: 'bg-orange-500/10 text-orange-300 ring-orange-500/30', text: 'text-orange-400' },
  severe: { badge: 'bg-red-500/10 text-red-300 ring-red-500/30', text: 'text-red-400' },
};

interface ImpactResult {
  corridorId: string;
  transferAmountUsd: number;
  pool: {
    tvlUsd: number;
    utilization: number;
  };
  impact: {
    poolSharePct: number;
    estimatedSlippageBps: number;
    impactLevel: ImpactLevel;
    warning: string | null;
  };
  fragility: {
    current: FragilityLevel;
  };
  corridorHealth: {
    status: HealthStatus;
    p50DurationSeconds: number | null;
    successRate1h: number | null;
  };
  disclaimer: string;
}

const selectClasses =
  'w-full bg-void-deep border border-ridge rounded px-3 py-2 min-h-[44px] text-sm text-lavender font-mono focus:outline-none focus:ring-1 focus:ring-gold/50 focus:border-gold/50 transition-colors';

const inputClasses =
  'w-full bg-void-deep border border-ridge rounded px-3 py-2 min-h-[44px] text-sm text-gold-bright font-mono placeholder-lavender-dim focus:outline-none focus:ring-1 focus:ring-gold/50 focus:border-gold/50 transition-colors';

export function ImpactCalculator(): React.JSX.Element {
  const [bridge, setBridge] = useState('across');
  const [source, setSource] = useState('ethereum');
  const [dest, setDest] = useState('arbitrum');
  const [amount, setAmount] = useState('');
  const [result, setResult] = useState<ImpactResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const availableChains = useMemo(() => BRIDGE_CHAINS[bridge] ?? [], [bridge]);

  const handleBridgeChange = useCallback((newBridge: string) => {
    const chains = BRIDGE_CHAINS[newBridge] ?? [];
    setBridge(newBridge);
    if (!chains.includes(source)) setSource(chains[0] ?? '');
    if (!chains.includes(dest)) setDest(chains[1] ?? chains[0] ?? '');
    setResult(null);
    setError(null);
  }, [source, dest]);

  const handleSourceChange = useCallback((newSource: string) => {
    setSource(newSource);
    if (newSource === dest) {
      const other = availableChains.find(c => c !== newSource);
      if (other) setDest(other);
    }
    setResult(null);
    setError(null);
  }, [dest, availableChains]);

  const handleDestChange = useCallback((newDest: string) => {
    setDest(newDest);
    if (newDest === source) {
      const other = availableChains.find(c => c !== newDest);
      if (other) setSource(other);
    }
    setResult(null);
    setError(null);
  }, [source, availableChains]);

  const handleSubmit = useCallback(async () => {
    const amountUsd = parseFloat(amount.replace(/,/g, ''));
    if (!amount || isNaN(amountUsd) || amountUsd <= 0) {
      setError('Please enter a valid positive amount.');
      return;
    }
    if (source === dest) {
      setError('Source and destination chains must differ.');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const params = new URLSearchParams({ bridge, source, dest, amountUsd: amountUsd.toString() });
      const res = await fetch(`/api/impact/estimate?${params.toString()}`);
      const json = await res.json() as ImpactResult & { error?: { message: string } };
      if (!res.ok) {
        setError(json.error?.message ?? 'Failed to calculate impact.');
      } else {
        setResult(json);
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [amount, bridge, source, dest]);

  const formatSeconds = (s: number | null): string => {
    if (s === null) return '--';
    if (s < 60) return `${s}s`;
    return `${(s / 60).toFixed(1)}m`;
  };

  return (
    <div className="space-y-4">
      {/* Form — stacks vertically on small screens, wraps on larger */}
      <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-end">
        <div className="xs:col-span-2 sm:col-span-1">
          <label className="block text-xs text-gold-dim font-mono mb-1 tracking-wider uppercase" htmlFor="impact-amount">
            Amount (USD)
          </label>
          <input
            id="impact-amount"
            type="text"
            inputMode="numeric"
            placeholder="5,000,000"
            value={amount}
            onChange={e => { setAmount(e.target.value); setResult(null); setError(null); }}
            className={inputClasses}
          />
        </div>

        <div>
          <label className="block text-xs text-gold-dim font-mono mb-1 tracking-wider uppercase" htmlFor="impact-bridge">
            Bridge
          </label>
          <select
            id="impact-bridge"
            value={bridge}
            onChange={e => handleBridgeChange(e.target.value)}
            className={selectClasses}
          >
            {Object.keys(BRIDGE_CHAINS).map(b => (
              <option key={b} value={b}>
                {b.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-gold-dim font-mono mb-1 tracking-wider uppercase" htmlFor="impact-source">
            From
          </label>
          <select
            id="impact-source"
            value={source}
            onChange={e => handleSourceChange(e.target.value)}
            className={selectClasses}
          >
            {availableChains.map(c => (
              <option key={c} value={c}>{CHAIN_LABEL[c] ?? c}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-gold-dim font-mono mb-1 tracking-wider uppercase" htmlFor="impact-dest">
            To
          </label>
          <select
            id="impact-dest"
            value={dest}
            onChange={e => handleDestChange(e.target.value)}
            className={selectClasses}
          >
            {availableChains.filter(c => c !== source).map(c => (
              <option key={c} value={c}>{CHAIN_LABEL[c] ?? c}</option>
            ))}
          </select>
        </div>

        <button
          onClick={handleSubmit}
          disabled={loading}
          type="button"
          className="w-full sm:w-auto px-5 py-2 min-h-[44px] bg-gold/20 hover:bg-gold/30 border border-gold/40 hover:border-gold/60 disabled:opacity-40 disabled:cursor-not-allowed text-gold-bright text-sm font-mono font-semibold rounded transition-all focus:outline-none focus:ring-2 focus:ring-gold/30 focus:ring-offset-2 focus:ring-offset-void-card tracking-wider uppercase"
        >
          {loading ? 'Scanning...' : 'Check Impact'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <p className="text-sm text-red-400 font-mono">{error}</p>
      )}

      {/* Result */}
      {result && (
        <div className="bg-void-deep rounded-lg border border-ridge p-4 space-y-3">
          <div className="grid grid-cols-2 xs:grid-cols-3 sm:flex sm:flex-wrap gap-3 sm:gap-4">
            {/* Impact level */}
            <div>
              <div className="text-xs text-gold-dim font-mono mb-1 uppercase tracking-wider">Impact</div>
              <span
                className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-mono font-medium ring-1 ring-inset capitalize ${IMPACT_STYLE[result.impact.impactLevel].badge}`}
              >
                {result.impact.impactLevel}
              </span>
            </div>

            {/* Pool share */}
            <div>
              <div className="text-xs text-gold-dim font-mono mb-1 uppercase tracking-wider">Pool share</div>
              <div className="text-sm font-mono text-radar">{result.impact.poolSharePct.toFixed(2)}%</div>
            </div>

            {/* Slippage */}
            <div>
              <div className="text-xs text-gold-dim font-mono mb-1 uppercase tracking-wider">Est. slippage</div>
              <div className="text-sm font-mono text-radar">{result.impact.estimatedSlippageBps.toFixed(1)} bps</div>
            </div>

            {/* Health */}
            <div>
              <div className="text-xs text-gold-dim font-mono mb-1 uppercase tracking-wider">Health</div>
              <div className="flex items-center gap-1.5">
                <StatusIndicator status={result.corridorHealth.status} size="sm" />
                <span className="text-sm text-lavender capitalize font-mono">{result.corridorHealth.status}</span>
              </div>
            </div>

            {/* Fragility */}
            <div>
              <div className="text-xs text-gold-dim font-mono mb-1 uppercase tracking-wider">Fragility</div>
              <FragilityBadge level={result.fragility.current} />
            </div>

            {/* p50 */}
            {result.corridorHealth.p50DurationSeconds !== null && (
              <div>
                <div className="text-xs text-gold-dim font-mono mb-1 uppercase tracking-wider">Median</div>
                <div className="text-sm font-mono text-radar">
                  {formatSeconds(result.corridorHealth.p50DurationSeconds)}
                </div>
              </div>
            )}
          </div>

          {/* Warning */}
          {result.impact.warning && (
            <div className={`text-sm font-mono ${IMPACT_STYLE[result.impact.impactLevel].text} flex items-start gap-2`}>
              <span className="flex-shrink-0">!</span>
              <span>{result.impact.warning}</span>
            </div>
          )}

          {/* Disclaimer */}
          <p className="text-xs text-lavender-dim font-mono border-t border-ridge pt-3">
            {result.disclaimer}
          </p>
        </div>
      )}
    </div>
  );
}
