# Corridor Scouts

> Real-time cross-chain transfer intelligence, bridge monitoring and corridor health analytics

[![Status](https://img.shields.io/badge/status-under%20development-yellow)](https://github.com/your-org/corridor-scouts)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## About

Corridor Scouts is a public dashboard and data infrastructure for monitoring and analyzing cross-chain transfer intelligence in real-time. The system tracks transfer flows, settlement times, and liquidity dynamics across major DeFi bridges including Across, CCTP, Stargate, and others.

**Key Features:**
- **Corridor Health Monitoring** - Real-time status tracking for bridge routes
- **Liquidity Flight Velocity** - Track how fast capital moves between chains
- **Transfer Analytics** - Settlement times, success rates, and anomaly detection
- **Fragility Scoring** - Assess corridor stability and utilization
- **Impact Preview** - Estimate liquidity impact before large transfers

**What We're Building:**
- Public dashboard gathering cross-chain transfer intelligence
- WebSocket support for real-time updates
- Data collection infrastructure for future structural DeFi metrics

---

## High Level System Architecture
```mermaid
flowchart TD

    A["Bridge Scouts<br/>Across / CCTP / Stargate"] --> B["Event Queue<br/>Redis"]

    B --> C["Transfer Processor"]
    B --> D["Pool Processor"]
    B --> E["Fragility Calculator"]

    C --> F[("PostgreSQL Database")]
    D --> F
    E --> F

    F --> G["REST API + WebSocket"]
    G --> H["Dashboard (Next.js)"]

    F --> I["Impact Calculator"]
    F --> J["LFV Calculator"]
    F --> K["Anomaly Detector"]
```

## Tech Stack

- **Frontend:** Next.js 15, React 18, Tailwind CSS
- **Backend:** Next.js API Routes, WebSocket
- **Database:** PostgreSQL (Prisma ORM)
- **Cache:** Redis
- **Event Processing:** Custom bridge scouts + event queue
- **Chain Interaction:** ethers.js with multi-chain RPC support

---

## Local Development

### Prerequisites

- Node.js 18+
- Docker & Docker Compose
- Git

### Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env.local
   # Edit .env.local with your configuration
   ```

3. **Start services**
   ```bash
   # Start PostgreSQL and Redis
   docker-compose up -d
   
   # View database logs (optional)
   docker-compose logs -f postgres
   ```

4. **Run database migrations**
   ```bash
   # Apply schema migrations
   npx prisma migrate dev
   
   # Validate schema
   npx prisma validate
   ```

5. **Start development server**
   ```bash
   npm run dev
   ```

The dashboard will be available at `http://localhost:3000`.

---

## Database Management

### View Database
```bash
npx prisma studio
```

### Apply Migrations
```bash
npx prisma migrate dev

# if schema is updated run
npx prisma generate
```

### Performance Optimization (Optional)
Apply partial indexes for better query performance on large datasets:
```bash
docker exec -i corridor-postgres psql -U postgres -d corridor_scouts < prisma/migrations/0001_partial_indexes/migration.sql
```

### Teardown
```bash
# Stop containers (keeps data)
docker-compose down

# Stop containers and remove volumes (deletes all data)
docker-compose down -v
```

### Tests
```bash
# Run unit tests
npm run test:unit

# Run tests with coverage report
npm run test:coverage

# Run typecheck to verify classes compile
npm run typecheck
```

### Smoke Test
Validates that all infrastructure dependencies are reachable (Postgres, Redis, Alchemy RPC). Requires Docker containers to be running and `.env.local` to be configured.

```bash
npm run smoke-test
```

Each check prints a pass/fail result:
- **env vars** — required variables present in `.env.local`
- **database** — Postgres connection and query
- **redis** — Redis connection
- **rpc** — Alchemy API key and Ethereum RPC

---

## Documentation

- [System Specification](docs/SYSTEM-SPEC.md) - Full technical specification
- [API Documentation](docs/API-SPEC.md) - API endpoints and usage
- [Architecture Diagrams](docs/ARCHITECTURE-DIAGRAMS.md) - System architecture
- [Product Requirements Document](docs/PRD.md)

---

## License

MIT License - see [LICENSE](LICENSE) for details

---

## Status

🚧 **Under Active Development** - This project is in early development. Expect breaking changes and incomplete features.

