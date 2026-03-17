# Architecture Diagrams
## Corridor Scout - Visual Documentation

This file contains Mermaid diagrams for the Corridor Scout system. Render these in any Mermaid-compatible viewer.

---

## 1. System Context Diagram

```mermaid
C4Context
    title System Context Diagram - Corridor Scout

    Person(user, "DeFi User", "Checks corridor health before transfers")
    Person(dev, "Developer", "Integrates via API")
    Person(researcher, "Researcher", "Analyzes cross-chain patterns")

    System(scout, "Corridor Scout", "Real-time bridge monitoring dashboard")

    System_Ext(ethereum, "Ethereum", "L1 Blockchain")
    System_Ext(arbitrum, "Arbitrum", "L2 Rollup")
    System_Ext(optimism, "Optimism", "L2 Rollup")
    System_Ext(base, "Base", "L2 Rollup")
    
    System_Ext(across, "Across Protocol", "Intent-based bridge")
    System_Ext(cctp, "Circle CCTP", "Native USDC bridge")
    System_Ext(stargate, "Stargate", "Liquidity pool bridge")

    Rel(user, scout, "Views dashboard")
    Rel(dev, scout, "Calls API")
    Rel(researcher, scout, "Queries data")
    
    Rel(scout, ethereum, "Reads events")
    Rel(scout, arbitrum, "Reads events")
    Rel(scout, optimism, "Reads events")
    Rel(scout, base, "Reads events")
    
    BiRel(across, ethereum, "Deposits")
    BiRel(across, arbitrum, "Fills")
    BiRel(cctp, ethereum, "Burns")
    BiRel(cctp, base, "Mints")
    BiRel(stargate, optimism, "Swaps")
```

---

## 2. Data Flow Sequence

```mermaid
sequenceDiagram
    autonumber
    participant SC as Source Chain
    participant Scout as Bridge Scout
    participant Proc as Transfer Processor
    participant DB as PostgreSQL
    participant RD as Redis (pub/sub)
    participant DC as Dest Chain
    participant API as API Layer
    participant UI as Dashboard

    Note over SC,DC: User initiates cross-chain transfer

    SC->>Scout: V3FundsDeposited event
    Scout->>Scout: Parse & normalize
    Scout->>Proc: processEvent(initiation)
    Proc->>DB: INSERT transfer (status=pending)
    Proc->>Proc: Add to pending map
    Proc->>RD: Publish transfer:initiated (WebSocket broadcast)

    Note over SC,DC: Time passes (~3-5 min for Across)

    DC->>Scout: FilledV3Relay event
    Scout->>Scout: Parse & normalize
    Scout->>Proc: processEvent(completion)
    Proc->>Proc: Match to pending transfer
    Proc->>Proc: Calculate duration
    Proc->>DB: UPDATE transfer (status=completed)
    Proc->>RD: Publish transfer:completed (WebSocket broadcast)

    Note over DB,UI: User requests data

    UI->>API: GET /api/corridors
    API->>DB: Query transfers, pools
    DB->>API: Return data
    API->>API: Calculate metrics
    API->>UI: JSON response
    UI->>UI: Render dashboard
```

---

## 3. Component Architecture

```mermaid
flowchart TB
    subgraph External["External Systems"]
        ETH[Ethereum RPC]
        ARB[Arbitrum RPC]
        OPT[Optimism RPC]
        BASE[Base RPC]
    end

    subgraph Scouts["Data Ingestion Layer"]
        AS[Across Scout]
        CS[CCTP Scout]
        SS[Stargate Scout]
    end

    subgraph Processing["Processing Layer"]
        TP[Transfer Processor]
        PP[Pool Processor]
        FC[Fragility Calculator]
        IC[Impact Calculator]
        LC[LFV Calculator]
    end

    subgraph Broadcast["WebSocket Broadcast"]
        RD[(Redis pub/sub)]
    end

    subgraph Storage["Storage Layer"]
        PG[(PostgreSQL)]
    end

    subgraph Jobs["Background Jobs"]
        SD[Stuck Detector]
        PS[Pool Snapshots]
        AD[Anomaly Detector]
    end

    subgraph API["API Layer"]
        REST[REST Endpoints]
        WS[WebSocket]
    end

    subgraph Frontend["Presentation Layer"]
        DASH[Dashboard]
        DETAIL[Corridor Detail]
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

    TP --> PG
    TP --> RD
    PP --> PG
    PP --> FC

    FC --> PG

    PG --> REST
    PG --> LC
    PG --> IC

    SD --> PG
    PS --> PG
    AD --> PG

    RD --> WS
    REST --> DASH
    WS --> DASH
    REST --> DETAIL

    style External fill:#f5f5f5
    style Scouts fill:#e3f2fd
    style Broadcast fill:#fff3e0
    style Processing fill:#e8f5e9
    style Storage fill:#fce4ec
    style Jobs fill:#f3e5f5
    style API fill:#e0f7fa
    style Frontend fill:#fff8e1
```

---

## 4. Database Entity Relationship

```mermaid
erDiagram
    TRANSFERS {
        bigint id PK
        string transfer_id UK
        string bridge
        string source_chain
        string dest_chain
        string asset
        decimal amount
        decimal amount_usd
        timestamp initiated_at
        timestamp completed_at
        int duration_seconds
        string status
        string tx_hash_source
        string tx_hash_dest
        bigint block_initiated
        bigint block_completed
        decimal gas_price_gwei
        string transfer_size_bucket
        int hour_of_day
        int day_of_week
        timestamp created_at
        timestamp updated_at
    }

    POOL_SNAPSHOTS {
        bigint id PK
        string pool_id
        string bridge
        string chain
        string asset
        decimal tvl
        decimal tvl_usd
        decimal available_liquidity
        decimal utilization
        timestamp recorded_at
    }

    ANOMALIES {
        bigint id PK
        string anomaly_type
        string corridor_id
        string bridge
        string source_chain
        string dest_chain
        string severity
        timestamp detected_at
        timestamp resolved_at
        json details
        timestamp created_at
    }

    TRANSFERS ||--o{ ANOMALIES : "triggers"
    POOL_SNAPSHOTS ||--o{ ANOMALIES : "triggers"
```

---

## 5. Transfer State Machine

```mermaid
stateDiagram-v2
    [*] --> Pending: Deposit event received

    Pending --> Completed: Fill event received
    Pending --> Stuck: Exceeds threshold
    Pending --> Failed: Explicit failure

    Stuck --> Completed: Late fill received
    Stuck --> Failed: Manual resolution

    Completed --> [*]
    Failed --> [*]

    note right of Pending
        Threshold varies by bridge:
        - Across: 30 min
        - CCTP: 45 min
        - Stargate: 30 min
    end note
```

---

## 6. Health Status Decision Tree

```mermaid
flowchart TD
    Start([Evaluate Corridor Health]) --> A{Success Rate 1h}
    
    A -->|< 95%| Down[🔴 DOWN]
    A -->|95-99%| B{Latency Check}
    A -->|≥ 99%| C{Latency Check}
    
    B -->|> 5x normal| Down
    B -->|2-5x normal| Degraded[🟡 DEGRADED]
    B -->|≤ 2x normal| Degraded
    
    C -->|> 5x normal| Down
    C -->|2-5x normal| Degraded
    C -->|≤ 2x normal| D{Transfer Volume}
    
    D -->|No transfers 1h| Degraded
    D -->|Has transfers| Healthy[🟢 HEALTHY]

    style Down fill:#ffcdd2
    style Degraded fill:#fff9c4
    style Healthy fill:#c8e6c9
```

---

## 7. Fragility Calculation Flow

```mermaid
flowchart TD
    Input[/"Pool Data:
    - utilization
    - tvl_usd  
    - net_flow_24h"/]
    
    Input --> U{Utilization > 60%?}
    
    U -->|Yes| High1[🔴 HIGH
    Reason: High utilization]
    
    U -->|No| F{Net Flow < -20%?}
    
    F -->|Yes| High2[🔴 HIGH
    Reason: Large outflow]
    
    F -->|No| U2{Utilization > 30%?}
    
    U2 -->|Yes| Med1[🟡 MEDIUM
    Reason: Moderate utilization]
    
    U2 -->|No| F2{Net Flow < -10%?}
    
    F2 -->|Yes| Med2[🟡 MEDIUM
    Reason: Moderate outflow]
    
    F2 -->|No| Low[🟢 LOW
    Reason: Pool is stable]

    style High1 fill:#ffcdd2
    style High2 fill:#ffcdd2
    style Med1 fill:#fff9c4
    style Med2 fill:#fff9c4
    style Low fill:#c8e6c9
```

---

## 8. LFV Interpretation Scale

```mermaid
flowchart LR
    subgraph Scale["Liquidity Flight Velocity Scale"]
        RF["🔴 Rapid Flight
        LFV < -10%"]
        MO["🟠 Moderate Outflow
        -10% ≤ LFV < -3%"]
        ST["🟢 Stable
        -3% ≤ LFV < 3%"]
        MI["🔵 Moderate Inflow
        3% ≤ LFV < 10%"]
        RI["🟣 Rapid Inflow
        LFV ≥ 10%"]
    end

    RF --- MO --- ST --- MI --- RI

    style RF fill:#ffcdd2
    style MO fill:#ffe0b2
    style ST fill:#c8e6c9
    style MI fill:#bbdefb
    style RI fill:#e1bee7
```

---

## 9. API Request Flow

```mermaid
sequenceDiagram
    participant Client
    participant Edge as Vercel Edge
    participant Cache as Redis Cache
    participant API as API Route
    participant DB as PostgreSQL
    participant Calc as Calculator

    Client->>Edge: GET /api/corridors
    Edge->>Edge: Rate limit check
    
    alt Rate limited
        Edge->>Client: 429 Too Many Requests
    else Allowed
        Edge->>Cache: Check cache
        alt Cache hit
            Cache->>Edge: Cached response
            Edge->>Client: 200 OK (cached)
        else Cache miss
            Edge->>API: Forward request
            API->>DB: Query transfers
            DB->>API: Transfer data
            API->>Calc: Calculate metrics
            Calc->>API: Computed metrics
            API->>Cache: Store response
            API->>Edge: JSON response
            Edge->>Client: 200 OK
        end
    end
```

---

## 10. Deployment Architecture

```mermaid
flowchart TB
    subgraph Internet
        Users[Users]
        Devs[Developers]
    end

    subgraph Cloudflare
        DNS[DNS]
    end

    subgraph Vercel["Vercel Platform"]
        subgraph Edge["Edge Network"]
            E1[Edge US]
            E2[Edge EU]
            E3[Edge Asia]
        end
        
        subgraph Functions["Serverless Functions"]
            F1["/api/health"]
            F2["/api/corridors"]
            F3["/api/flight"]
            F4["/api/impact"]
        end
        
        subgraph Cron["Cron Jobs"]
            C1["Pool Snapshots
            (every 5 min)"]
            C2["Stuck Detector
            (every 1 min)"]
        end
        
        subgraph Static["Static Assets"]
            S1[Dashboard HTML]
            S2[JS Bundle]
            S3[CSS]
        end
    end

    subgraph External["External Services"]
        DB[(Neon PostgreSQL)]
        Redis[(Upstash Redis)]
        RPC[Alchemy RPC]
    end

    Users --> DNS
    Devs --> DNS
    DNS --> Edge

    E1 --> Functions
    E2 --> Functions
    E3 --> Functions

    Edge --> Static

    Functions --> DB
    Functions --> Redis
    Cron --> DB
    Cron --> RPC

    style Vercel fill:#000,color:#fff
    style Edge fill:#333,color:#fff
    style Functions fill:#0070f3,color:#fff
    style Cron fill:#7928ca,color:#fff
```

---

## 11. Dashboard Component Tree

```mermaid
flowchart TB
    subgraph Dashboard["Dashboard Page"]
        Layout[Layout]
        
        Layout --> Header[Header]
        Layout --> Main[Main Content]
        Layout --> Footer[Footer]
        
        Header --> Logo[Logo]
        Header --> LiveIndicator[Live Indicator]
        
        Main --> Grid[Grid Layout]
        
        Grid --> HS[HealthSummary]
        Grid --> FV[FlightVelocity]
        Grid --> AL[AlertList]
        Grid --> IC[ImpactCalculator]
        Grid --> CT[CorridorTable]
        
        HS --> StatCard1[Corridors Count]
        HS --> StatCard2[Healthy Count]
        HS --> StatCard3[Degraded Count]
        HS --> StatCard4[Down Count]
        
        FV --> ChainBar1[ETH Bar]
        FV --> ChainBar2[ARB Bar]
        FV --> ChainBar3[BASE Bar]
        
        AL --> AlertItem1[Alert 1]
        AL --> AlertItem2[Alert 2]
        
        IC --> AmountInput[Amount Input]
        IC --> BridgeSelect[Bridge Select]
        IC --> ChainSelects[Chain Selects]
        IC --> ResultDisplay[Impact Result]
        
        CT --> TableHeader[Table Header]
        CT --> TableBody[Table Body]
        CT --> Pagination[Pagination]
    end

    style Dashboard fill:#f5f5f5
    style HS fill:#e3f2fd
    style FV fill:#e8f5e9
    style AL fill:#ffebee
    style IC fill:#fff3e0
    style CT fill:#f3e5f5
```

---

## 12. Weekly Build Timeline

```mermaid
gantt
    title Corridor Scout Build Timeline
    dateFormat  YYYY-MM-DD
    
    section Foundation
    Project Setup           :w1, 2026-02-24, 3d
    Database Schema         :w1b, after w1, 2d
    Across Scout (ETH→ARB)  :w2, after w1b, 5d
    
    section Core Scouts
    CCTP Scout              :w3a, after w2, 3d
    Stargate Scout          :w3b, after w3a, 2d
    Transfer Processor      :w3c, after w3b, 2d
    Pool Snapshot Collector :w3d, after w3c, 2d
    
    section Calculations
    Fragility Calculator    :w4a, after w3d, 2d
    Impact Calculator       :w4b, after w4a, 2d
    LFV Calculator          :w4c, after w4b, 2d
    Anomaly Detection       :w4d, after w4c, 2d
    
    section API
    Health Endpoint         :w5a, after w4d, 1d
    Flight Endpoint         :w5b, after w5a, 1d
    Corridors Endpoints     :w5c, after w5b, 2d
    Impact Endpoint         :w5d, after w5c, 1d
    
    section Dashboard
    Main Page Layout        :w6a, after w5d, 2d
    Health Summary          :w6b, after w6a, 1d
    Flight Velocity         :w6c, after w6b, 1d
    Alert List              :w6d, after w6c, 1d
    Corridor Table          :w6e, after w6d, 1d
    Impact Calculator UI    :w6f, after w6e, 1d
    
    section Polish
    Corridor Detail Page    :w7a, after w6f, 2d
    Mobile Responsive       :w7b, after w7a, 2d
    Error Handling          :w7c, after w7b, 1d
    
    section Launch
    Deploy to Vercel        :w8a, after w7c, 1d
    Open Source             :w8b, after w8a, 1d
    Announcement            :w8c, after w8b, 1d
```