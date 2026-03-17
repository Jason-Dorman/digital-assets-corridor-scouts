# System Specification
## Corridor Scout - Technical Architecture

**Version:** 1.0  
**Date:** February 2026

---

## 1. System Overview

### 1.1 High-Level Architecture

```mermaid
flowchart TB
    subgraph External["EXTERNAL CHAINS"]
        ETH[Ethereum]
        ARB[Arbitrum]
        OPT[Optimism]
        BASE[Base]
    end

    subgraph System["CORRIDOR SCOUT SYSTEM"]
        subgraph Ingestion["DATA INGESTION LAYER"]
            AS[Across Scout<br/>ETH, ARB, OPT, BASE, POLY]
            CS[CCTP Scout<br/>ETH, ARB, OPT, BASE, AVAX]
            SS[Stargate Scout<br/>ETH, ARB, OPT, AVAX, POLY]
        end

        subgraph Processing["PROCESSING LAYER"]
            TP[Transfer Processor<br/>• Match initiations to completions<br/>• Calculate settlement duration<br/>• Classify by size bucket<br/>• Update transfer status]
            FC[Fragility Calculator]
            IC[Impact Calculator]
            LC[LFV Calculator]
        end

        subgraph Broadcast["WEBSOCKET BROADCAST"]
            Redis[(Redis pub/sub<br/>• transfer:initiated<br/>• transfer:completed)]
        end

        subgraph Storage["STORAGE LAYER"]
            DB[(PostgreSQL<br/>• transfers<br/>• pool_snapshots<br/>• anomalies)]
        end

        subgraph API["API LAYER"]
            Routes[Next.js API Routes<br/>GET /api/health<br/>GET /api/flight<br/>GET /api/corridors<br/>GET /api/corridors/:id<br/>GET /api/impact/estimate<br/>GET /api/anomalies]
            WS[WebSocket Server<br/>Real-time updates]
        end

        subgraph Presentation["PRESENTATION LAYER"]
            Dashboard[Next.js Dashboard<br/>• HealthSummary<br/>• FlightVelocity<br/>• AlertList<br/>• ImpactCalculator<br/>• CorridorTable]
        end
    end

    ETH --> AS
    ARB --> AS
    OPT --> AS
    BASE --> AS
    ETH --> CS
    ARB --> CS
    OPT --> CS
    BASE --> CS
    ETH --> SS
    ARB --> SS
    OPT --> SS

    AS --> TP
    CS --> TP
    SS --> TP

    TP --> Redis
    TP --> FC
    TP --> IC
    TP --> LC
    TP --> DB
    FC --> DB
    
    DB --> Routes
    Routes --> WS
    Routes --> Dashboard
    WS --> Dashboard
```

---

## 2. Data Flow Diagrams

### 2.1 Transfer Event Flow

```mermaid
sequenceDiagram
    autonumber
    participant SC as Source Chain
    participant AS as Across Scout
    participant TP as Transfer Processor
    participant DB as Database
    participant RD as Redis (WebSocket)
    participant DC as Dest Chain
    participant AS2 as Across Scout (dest)

    Note over SC: User initiates transfer

    SC->>AS: V3FundsDeposited Event<br/>depositId: 12345<br/>inputToken: USDC<br/>inputAmount: 10000000000<br/>destinationChainId: 42161
    AS->>AS: Parse event data<br/>Create TransferID<br/>Normalize amounts
    AS->>TP: processEvent(initiationEvent)
    TP->>DB: INSERT transfer<br/>status: 'pending'
    TP->>TP: Add to pending map
    TP->>RD: Publish transfer:initiated<br/>(for WebSocket broadcast)

    Note over SC,DC: ⏱️ Time passes (~3-5 minutes)

    DC->>AS2: FilledV3Relay Event<br/>depositId: 12345<br/>originChainId: 1<br/>relayer: 0xdef...<br/>outputAmount: 9995000000
    AS2->>TP: processEvent(completionEvent)
    TP->>TP: Match to pending transfer<br/>Calculate duration
    TP->>DB: UPDATE transfer<br/>completed_at: now<br/>duration: 210s<br/>status: 'completed'
    TP->>RD: Publish transfer:completed<br/>(for WebSocket broadcast)
```

### 2.2 Calculation Flow

```mermaid
flowchart TB
    subgraph Triggers["SCHEDULED TRIGGERS"]
        T1[Every 1m<br/>Stuck Check]
        T2[Every 5m<br/>Pool Snapshot]
        T3[Every 15m<br/>Anomaly Scan]
    end

    subgraph Processors["PROCESSORS"]
        SD[Stuck Detector<br/>Query pending transfers<br/>older than threshold<br/>Mark as 'stuck'<br/>Create anomaly]
        PP[Pool Processor<br/>Fetch on-chain pool TVL<br/>Calculate utilization]
        AD[Anomaly Detector<br/>Query recent transfers for:<br/>• Latency spikes<br/>• Failure clusters<br/>• Liquidity drops]
    end

    subgraph Calculators["CALCULATORS"]
        FC[Fragility Calculator<br/>Inputs: utilization, tvl_usd, net_flow_24h<br/>Output: level L/M/H, reason]
    end

    subgraph Storage["DATABASE"]
        DB[(PostgreSQL<br/>transfers<br/>pool_snapshots<br/>anomalies)]
    end

    subgraph OnDemand["ON-DEMAND (API)"]
        LFV[LFV Calculator<br/>Input: chain<br/>1. Get current pool snapshots<br/>2. Get snapshots from 24h ago<br/>3. Calculate lfv = delta/start<br/>4. Classify interpretation]
    end

    T1 --> SD
    T2 --> PP
    T3 --> AD

    SD --> DB
    PP --> FC
    PP --> DB
    FC --> DB
    AD --> DB

    DB --> LFV
    LFV --> |"Output: {chain, lfv24h, interpretation, netFlowUsd}"| API[API Response]
```

---

## 3. Database Schema

### 3.1 Entity Relationship Diagram

```mermaid
erDiagram
    TRANSFERS {
        bigserial id PK
        text transfer_id UK "NOT NULL"
        text bridge "NOT NULL"
        text source_chain "NOT NULL"
        text dest_chain "NOT NULL"
        text asset "NOT NULL"
        numeric amount "NOT NULL"
        numeric amount_usd
        timestamptz initiated_at "NOT NULL"
        timestamptz completed_at
        integer duration_seconds
        text status "DEFAULT 'pending'"
        text tx_hash_source
        text tx_hash_dest
        bigint block_initiated
        bigint block_completed
        numeric gas_price_gwei
        text transfer_size_bucket
        integer hour_of_day "0-23"
        integer day_of_week "0-6"
        timestamptz created_at "DEFAULT NOW()"
        timestamptz updated_at "DEFAULT NOW()"
    }

    POOL_SNAPSHOTS {
        bigserial id PK
        text pool_id "NOT NULL"
        text bridge "NOT NULL"
        text chain "NOT NULL"
        text asset "NOT NULL"
        numeric tvl "NOT NULL"
        numeric tvl_usd
        numeric available_liquidity
        numeric utilization "0-100"
        timestamptz recorded_at "NOT NULL"
    }

    ANOMALIES {
        bigserial id PK
        text anomaly_type "NOT NULL (latency_spike, failure_cluster, liquidity_drop, stuck_transfer)"
        text corridor_id "NOT NULL"
        text bridge "NOT NULL"
        text source_chain
        text dest_chain
        text severity "NOT NULL (low, medium, high)"
        timestamptz detected_at "NOT NULL"
        timestamptz resolved_at
        jsonb details
        timestamptz created_at "DEFAULT NOW()"
    }

    TRANSFERS ||--o{ ANOMALIES : "triggers"
    POOL_SNAPSHOTS ||--o{ ANOMALIES : "triggers"
```

**Indexes:**
- `transfers`: (bridge, source_chain, dest_chain, initiated_at DESC), (status) WHERE status = 'pending', (bridge, initiated_at DESC)
- `pool_snapshots`: (pool_id, recorded_at DESC), (chain, recorded_at DESC)
- `anomalies`: (corridor_id) WHERE resolved_at IS NULL, (detected_at DESC)

### 3.2 Prisma Schema

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Transfer {
  id               BigInt    @id @default(autoincrement())
  transferId       String    @unique @map("transfer_id")
  bridge           String
  sourceChain      String    @map("source_chain")
  destChain        String    @map("dest_chain")
  asset            String
  amount           Decimal
  amountUsd        Decimal?  @map("amount_usd")
  initiatedAt      DateTime  @map("initiated_at")
  completedAt      DateTime? @map("completed_at")
  durationSeconds  Int?      @map("duration_seconds")
  status           String    @default("pending")
  txHashSource     String?   @map("tx_hash_source")
  txHashDest       String?   @map("tx_hash_dest")
  blockInitiated   BigInt?   @map("block_initiated")
  blockCompleted   BigInt?   @map("block_completed")
  gasPriceGwei     Decimal?  @map("gas_price_gwei")
  transferSizeBucket String? @map("transfer_size_bucket")
  hourOfDay        Int?      @map("hour_of_day")
  dayOfWeek        Int?      @map("day_of_week")
  createdAt        DateTime  @default(now()) @map("created_at")
  updatedAt        DateTime  @updatedAt @map("updated_at")

  @@index([bridge, sourceChain, destChain, initiatedAt(sort: Desc)], name: "idx_transfers_corridor")
  @@index([status], name: "idx_transfers_pending")
  @@index([bridge, initiatedAt(sort: Desc)], name: "idx_transfers_bridge")
  @@map("transfers")
}

model PoolSnapshot {
  id                BigInt   @id @default(autoincrement())
  poolId            String   @map("pool_id")
  bridge            String
  chain             String
  asset             String
  tvl               Decimal
  tvlUsd            Decimal? @map("tvl_usd")
  availableLiquidity Decimal? @map("available_liquidity")
  utilization       Decimal?
  recordedAt        DateTime @map("recorded_at")

  @@index([poolId, recordedAt(sort: Desc)], name: "idx_pool_snapshots_pool")
  @@index([chain, recordedAt(sort: Desc)], name: "idx_pool_snapshots_chain")
  @@map("pool_snapshots")
}

model Anomaly {
  id           BigInt    @id @default(autoincrement())
  anomalyType  String    @map("anomaly_type")
  corridorId   String    @map("corridor_id")
  bridge       String
  sourceChain  String?   @map("source_chain")
  destChain    String?   @map("dest_chain")
  severity     String
  detectedAt   DateTime  @map("detected_at")
  resolvedAt   DateTime? @map("resolved_at")
  details      Json?
  createdAt    DateTime  @default(now()) @map("created_at")

  @@index([corridorId], name: "idx_anomalies_active")
  @@index([detectedAt(sort: Desc)], name: "idx_anomalies_time")
  @@map("anomalies")
}
```

---

## 4. Component Architecture

### 4.1 Scout Component Pattern

```mermaid
classDiagram
    class BaseScout {
        <<abstract>>
        #rpcProviders: Map~ChainName, Provider~
        #chains: ChainName[]
        #isRunning: boolean
        #eventListeners: Array~cleanup~
        -onEvent: TransferEvent→Promise~void~
        -blockCache: Map~blockNumber, Date~
        +start()* Promise~void~
        +stop()* Promise~void~
        +getContractAddress(chain)* string
        #parseDepositEvent(log, chainId, timestamp)* TransferEvent|null
        #parseFillEvent(log, chainId, timestamp)* TransferEvent|null
        #emit(event) void
        #getBlockTimestamp(provider, blockNumber) Date
        #generateTransferId(chainId, identifier) string
    }

    class AcrossScout {
        Contract: SpokePool
        Events: V3FundsDeposited, FilledV3Relay
        Chains: ETH, ARB, OPT, BASE, POLY
        TransferId: originChainId_depositId
        +start() Promise~void~
        +stop() Promise~void~
        +getContractAddress(chain) string
        #parseDepositEvent(log, chainId, timestamp) TransferEvent|null
        #parseFillEvent(log, chainId, timestamp) TransferEvent|null
    }

    class CCTPScout {
        Contract: TokenMessenger, MessageTransmitter
        Events: DepositForBurn, MessageReceived
        Chains: ETH, ARB, OPT, BASE, AVAX
        TransferId: sourceDomain_nonce
        +start() Promise~void~
        +stop() Promise~void~
        +getContractAddress(chain) string
        #parseDepositEvent(log, chainId, timestamp) TransferEvent|null
        #parseFillEvent(log, chainId, timestamp) TransferEvent|null
    }

    class StargateScout {
        Contract: Router, Pool
        Events: Swap
        Chains: ETH, ARB, OPT, AVAX, POLY
        TransferId: chainId_txHash
        +start() Promise~void~
        +stop() Promise~void~
        +getContractAddress(chain) string
        #parseDepositEvent(log, chainId, timestamp) TransferEvent|null
        #parseFillEvent(log, chainId, timestamp) TransferEvent|null
    }

    BaseScout <|-- AcrossScout
    BaseScout <|-- CCTPScout
    BaseScout <|-- StargateScout
```

### 4.2 API Route Structure

```mermaid
flowchart LR
    subgraph API["src/app/api/"]
        subgraph Health["health/"]
            H[route.ts<br/>GET /api/health]
        end
        
        subgraph Flight["flight/"]
            F[route.ts<br/>GET /api/flight]
        end
        
        subgraph Corridors["corridors/"]
            C1[route.ts<br/>GET /api/corridors]
            subgraph CorridorID["[id]/"]
                C2[route.ts<br/>GET /api/corridors/:id]
            end
        end
        
        subgraph Impact["impact/"]
            subgraph Estimate["estimate/"]
                I[route.ts<br/>GET /api/impact/estimate]
            end
        end
        
        subgraph Anomalies["anomalies/"]
            A[route.ts<br/>GET /api/anomalies]
        end
    end

    H --> |"Response"| HR["{status, corridorsMonitored,<br/>corridorsHealthy, corridorsDegraded,<br/>corridorsDown, transfers24h,<br/>successRate24h, activeAnomalies}"]
    
    F --> |"Response"| FR["{chains: [{chain, lfv24h,<br/>interpretation, netFlowUsd, alert?}]}"]
    
    C1 --> |"Response"| CR["{corridors: Corridor[]}"]
    C2 --> |"Response"| CDR["{corridor, recentTransfers,<br/>hourlyStats, anomalies}"]
    
    I --> |"Response"| IR["{corridorId, transferAmountUsd,<br/>pool, impact, fragility,<br/>corridorHealth, disclaimer}"]
    
    A --> |"Response"| AR["{anomalies: Anomaly[]}"]
```

---

## 5. State Management

### 5.1 Client-Side Data Flow

```mermaid
flowchart TB
    subgraph SWR["REACT QUERY / SWR"]
        subgraph Keys["QUERY KEYS"]
            K1["['health'] → useHealth()"]
            K2["['flight'] → useFlightVelocity()"]
            K3["['corridors'] → useCorridors(filters)"]
            K4["['corridor', id] → useCorridor(id)"]
            K5["['anomalies'] → useAnomalies(filters)"]
        end
        
        subgraph Cache["CACHE CONFIGURATION"]
            C1["health: staleTime 30s, refetch 30s"]
            C2["flight: staleTime 60s, refetch 60s"]
            C3["corridors: staleTime 30s, refetch 30s"]
            C4["anomalies: staleTime 15s, refetch 15s"]
        end
    end

    subgraph WS["WEBSOCKET LAYER"]
        E1["transfer:new → Invalidate ['corridors']"]
        E2["transfer:complete → Invalidate ['corridors'], ['health']"]
        E3["anomaly:new → Invalidate ['anomalies'], ['health']"]
        E4["anomaly:resolved → Invalidate ['anomalies']"]
    end

    subgraph Components["COMPONENT TREE"]
        Dashboard["Dashboard"]
        HS["HealthSummary ← useHealth()"]
        FV["FlightVelocity ← useFlightVelocity()"]
        AL["AlertList ← useAnomalies"]
        IC["ImpactCalculator ← Local state + useMutation"]
        CT["CorridorTable ← useCorridors()"]
    end

    Keys --> Cache
    Cache --> WS
    WS --> Components
    Dashboard --> HS
    Dashboard --> FV
    Dashboard --> AL
    Dashboard --> IC
    Dashboard --> CT
```

---

## 6. Deployment Architecture

```mermaid
flowchart TB
    Internet[("🌐 INTERNET")]
    
    subgraph Cloudflare["CLOUDFLARE"]
        DNS[DNS<br/>corridorscout.com]
    end

    subgraph Vercel["VERCEL"]
        subgraph Edge["EDGE NETWORK"]
            E1[Edge US-East]
            E2[Edge EU-West]
            E3[Edge AP-Tokyo]
        end
        
        subgraph Functions["SERVERLESS FUNCTIONS"]
            F1["/api/health"]
            F2["/api/flight"]
            F3["/api/corridors"]
            F4["/api/impact"]
        end
        
        subgraph Cron["CRON JOBS"]
            CR1["/api/cron/pool-snapshots<br/>(every 5 min)"]
            CR2["/api/cron/stuck-detector<br/>(every 1 min)"]
        end
    end

    subgraph External["EXTERNAL SERVICES"]
        Neon[(NEON PostgreSQL<br/>• transfers<br/>• pool_snapshots<br/>• anomalies<br/>Region: US-East)]
        Upstash[(UPSTASH Redis<br/>• Event queue<br/>• Pub/sub<br/>• Rate limiting<br/>Region: Global)]
        Alchemy[ALCHEMY RPC<br/>• ETH Mainnet<br/>• Arbitrum<br/>• Optimism<br/>• Base<br/>• Polygon]
    end

    Internet --> DNS
    DNS --> Edge
    Edge --> Functions
    Functions --> Neon
    Functions --> Upstash
    Cron --> Neon
    Cron --> Alchemy
```

---

## 7. Error Handling Strategy

```mermaid
flowchart TB
    subgraph RPC["RPC TIMEOUT"]
        R1[RPC Call Fails] --> R2{Retry<br/>3x with backoff}
        R2 -->|Success| R3[Continue]
        R2 -->|All failed| R4[Fallback RPC]
        R4 --> R5[Use cached data<br/>Mark stale]
    end

    subgraph DB["DATABASE ERROR"]
        D1[DB Call Fails] --> D2{Retry once}
        D2 -->|Success| D3[Continue]
        D2 -->|Failed| D4[Circuit Breaker]
        D4 --> D5[Open after 5 failures<br/>Half-open after 30s<br/>Close on success]
        D5 --> D6[Return cached response]
    end

    subgraph Match["MISSING TRANSFER MATCH"]
        M1[Completion without<br/>Initiation] --> M2[Log warning<br/>Store orphan]
        M2 --> M3[Orphan Queue]
        M3 --> M4[Retry match after 5min<br/>Discard after 1hr]
        M2 --> M5[Alert if pattern emerges]
    end

    subgraph Rate["API RATE LIMIT"]
        L1[Rate Limit Hit] --> L2[Queue request<br/>429 response]
        L2 --> L3[Rate Limiter]
        L3 --> L4[Exponential backoff<br/>Max 100 req/min/IP]
    end
```

**Impact Summary:**

| Error Type | Handling | User Impact |
|------------|----------|-------------|
| RPC Timeout | Retry 3x → Fallback → Cache | None (transparent) |
| Database Error | Retry → Circuit breaker → Cache | Brief stale data |
| Missing Match | Orphan queue → Retry → Discard | None |
| API Rate Limit | Queue → Backoff | Slight delay |

---

## 8. Monitoring & Observability

```mermaid
flowchart TB
    subgraph Metrics["METRICS"]
        subgraph System["System Health"]
            S1["API response time (p50, p90, p99)"]
            S2["Error rate by endpoint"]
            S3["Active WebSocket connections"]
            S4["Database query latency"]
        end
        
        subgraph Business["Business Metrics"]
            B1["Transfers processed per minute"]
            B2["Match rate (completions to initiations)"]
            B3["Anomalies detected per hour"]
            B4["API calls by endpoint"]
        end
    end

    subgraph Alerts["ALERTS"]
        subgraph Critical["Critical (Page immediately)"]
            C1["API error rate > 5% for 5 min"]
            C2["No transfers processed for 15 min"]
            C3["Database unreachable"]
        end
        
        subgraph Warning["Warning (Slack notification)"]
            W1["Match rate drops below 95%"]
            W2["RPC errors spike"]
            W3["Unusual traffic patterns"]
        end
    end

    subgraph Logging["LOGGING"]
        L1["ERROR: Failures requiring attention"]
        L2["WARN: Unexpected but handled"]
        L3["INFO: Key business events"]
        L4["DEBUG: Detailed flow (disabled in prod)"]
        
        Format["Structured Format:<br/>{timestamp, level, message,<br/>transferId, bridge, corridor, durationMs}"]
    end
```

---

## 9. Security Considerations

### 9.1 Attack Vectors & Mitigations

| Vector | Risk | Mitigation |
|--------|------|------------|
| DDoS | Service unavailable | Vercel edge caching, rate limiting |
| API abuse | Resource exhaustion | IP-based rate limits (100/min) |
| SQL injection | Data breach | Prisma parameterized queries |
| XSS | Data theft | React auto-escaping, CSP headers |
| Data poisoning | Wrong metrics | Validate event signatures |

### 9.2 Security Headers

```typescript
// next.config.js
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-XSS-Protection', value: '1; mode=block' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Content-Security-Policy', value: "default-src 'self'; ..." }
];
```

---

## 10. Future Considerations (Post-Phase 0)

- **Authentication**: API keys for higher rate limits
- **Webhooks**: Push notifications for anomalies
- **Historical API**: Query past corridor performance
- **Multi-bridge comparison**: Side-by-side route analysis
- **Structural metrics**: Deep liquidity analysis (Phase 1)