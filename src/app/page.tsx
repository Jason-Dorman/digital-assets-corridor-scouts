import { HealthSummary } from '../components/HealthSummary';
import { FlightVelocity } from '../components/FlightVelocity';
import { AlertList } from '../components/AlertList';
import { ImpactCalculator } from '../components/ImpactCalculator';
import { CorridorTable } from '../components/CorridorTable';
import { LiveIndicator } from '../components/LiveIndicator';

export default function DashboardPage(): React.JSX.Element {
  return (
    <div className="min-h-screen bg-void-deep radar-grid">
      {/* Header bar */}
      <header className="sticky top-0 z-20 border-b border-ridge bg-void/95 backdrop-blur-md gold-accent-top">
        <div className="mx-auto max-w-7xl px-3 xs:px-4 sm:px-6 lg:px-8">
          <div className="flex h-12 xs:h-14 items-center justify-between">
            <div className="flex items-center gap-2 xs:gap-3">
              {/* Radar icon */}
              <div className="relative h-6 w-6 xs:h-7 xs:w-7 flex items-center justify-center flex-shrink-0">
                <div className="absolute inset-0 rounded-full border border-gold/30" />
                <div className="absolute inset-1 rounded-full border border-gold/20" />
                <div className="h-1.5 w-1.5 rounded-full bg-gold animate-glow" />
              </div>
              <h1 className="text-xs xs:text-sm font-bold tracking-[0.15em] xs:tracking-[0.25em] text-gold-text uppercase">
                Corridor Scout
              </h1>
            </div>
            <LiveIndicator />
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-7xl px-3 xs:px-4 sm:px-6 lg:px-8 py-4 xs:py-6 space-y-4 xs:space-y-6">
        {/* Health summary */}
        <section aria-labelledby="health-heading">
          <HealthSummary />
        </section>

        {/* Two-column layout: Flight + Alerts side by side on desktop */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 xs:gap-6">
          {/* Liquidity Flight Velocity */}
          <section aria-labelledby="flight-heading">
            <h2 id="flight-heading" className="section-heading mb-3">
              Liquidity Flight (24h)
            </h2>
            <div className="card-radar p-4">
              <FlightVelocity />
            </div>
          </section>

          {/* Active Alerts */}
          <section aria-labelledby="alerts-heading">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="alerts-heading" className="section-heading">
                Active Alerts
              </h2>
            </div>
            <AlertList />
          </section>
        </div>

        {/* Impact Calculator */}
        <section aria-labelledby="impact-heading">
          <h2 id="impact-heading" className="section-heading mb-3">
            Impact Calculator
          </h2>
          <div className="card-radar p-4">
            <ImpactCalculator />
          </div>
        </section>

        {/* Corridors table */}
        <section aria-labelledby="corridors-heading">
          <h2 id="corridors-heading" className="section-heading mb-3">
            Corridors
          </h2>
          <CorridorTable />
        </section>
      </main>

      {/* Footer accent line */}
      <div className="h-px bg-gradient-to-r from-transparent via-ridge-bright to-transparent" />
    </div>
  );
}
