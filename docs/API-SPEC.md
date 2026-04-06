# API Specification
## Corridor Scout REST API

**Version:** 1.0  
**Base URL:** `https://corridorscout.com/api`

---

## Overview

The Corridor Scout API provides programmatic access to cross-chain bridge health data. All endpoints return JSON and support CORS for browser-based access.

### Rate Limits
- **Anonymous:** 100 requests/minute per IP
- **Authenticated (future):** 1000 requests/minute per API key

### Response Format
All responses follow this structure:

```typescript
// Success
{
  "data": { ... },
  "meta": {
    "updatedAt": "2026-02-21T14:35:00Z",
    "cached": false
  }
}

// Error
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid bridge parameter",
    "details": { "field": "bridge", "value": "unknown" }
  }
}
```

---

## Endpoints

### GET /api/health

System-wide health overview.

#### Response

```typescript
interface HealthResponse {
  status: "operational" | "degraded" | "down";
  corridorsMonitored: number;
  corridorsHealthy: number;
  corridorsDegraded: number;
  corridorsDown: number;
  transfers24h: number;
  successRate24h: number | null;  // 0-100, null when no transfers have resolved
  activeAnomalies: number;
  updatedAt: string;       // ISO8601
}
```

#### Example

```bash
curl https://corridorscout.com/api/health
```

```json
{
  "data": {
    "status": "operational",
    "corridorsMonitored": 47,
    "corridorsHealthy": 44,
    "corridorsDegraded": 2,
    "corridorsDown": 1,
    "transfers24h": 15234,
    "successRate24h": 98.7,
    "activeAnomalies": 2,
    "updatedAt": "2026-02-21T14:35:00Z"
  }
}
```

---

### GET /api/flight

Liquidity Flight Velocity by chain.

#### Response

```typescript
interface FlightResponse {
  chains: ChainFlight[];
  updatedAt: string;
}

interface ChainFlight {
  chain: string;
  lfv24h: number;           // Decimal, e.g., 0.021 = 2.1%
  lfvAnnualized: number;    // Projected annual rate
  interpretation: "rapid_flight" | "moderate_outflow" | "stable" | "moderate_inflow" | "rapid_inflow";
  netFlowUsd: number;       // Absolute USD amount
  tvlStartUsd: number;      // TVL 24h ago
  tvlNowUsd: number;        // Current TVL
  poolsMonitored: number;
  alert?: boolean;          // True if requires attention
}
```

#### Example

```bash
curl https://corridorscout.com/api/flight
```

```json
{
  "data": {
    "chains": [
      {
        "chain": "ethereum",
        "lfv24h": 0.021,
        "lfvAnnualized": 7.67,
        "interpretation": "stable",
        "netFlowUsd": 125000000,
        "tvlStartUsd": 5952380952,
        "tvlNowUsd": 6077380952,
        "poolsMonitored": 12
      },
      {
        "chain": "base",
        "lfv24h": -0.082,
        "lfvAnnualized": -29.93,
        "interpretation": "rapid_flight",
        "netFlowUsd": -45000000,
        "tvlStartUsd": 548780488,
        "tvlNowUsd": 503780488,
        "poolsMonitored": 8,
        "alert": true
      }
    ],
    "updatedAt": "2026-02-21T14:35:00Z"
  }
}
```

---

### GET /api/corridors

List all monitored corridors with health metrics.

#### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `bridge` | string | Filter by bridge (across, cctp, stargate) |
| `source` | string | Filter by source chain |
| `dest` | string | Filter by destination chain |
| `status` | string | Filter by health status (healthy, degraded, down) |
| `sort` | string | Sort field (p50, p90, transfers, fragility) |
| `order` | string | Sort order (asc, desc) |
| `limit` | number | Max results (default 100, max 500) |
| `offset` | number | Pagination offset |

#### Response

```typescript
interface CorridorsResponse {
  corridors: Corridor[];
  total: number;
  limit: number;
  offset: number;
}

interface Corridor {
  corridorId: string;        // e.g., "across_ethereum_arbitrum"
  bridge: string;
  sourceChain: string;
  destChain: string;
  status: "healthy" | "degraded" | "down";
  metrics: {
    transferCount1h: number;
    transferCount24h: number;
    successRate1h: number | null;   // 0-100, null when no resolved transfers
    successRate24h: number | null;  // 0-100, null when no resolved transfers
    p50DurationSeconds: number;
    p90DurationSeconds: number;
    volumeUsd24h: number;
  };
  pool: {
    tvlUsd: number;
    utilization: number;     // 0-100
    fragility: "low" | "medium" | "high";
    fragilityReason: string;
  };
  lastTransferAt: string;    // ISO8601
}
```

#### Example

```bash
curl "https://corridorscout.com/api/corridors?bridge=across&status=healthy&sort=p50&order=asc"
```

```json
{
  "data": {
    "corridors": [
      {
        "corridorId": "across_ethereum_arbitrum",
        "bridge": "across",
        "sourceChain": "ethereum",
        "destChain": "arbitrum",
        "status": "healthy",
        "metrics": {
          "transferCount1h": 47,
          "transferCount24h": 1124,
          "successRate1h": 100,
          "successRate24h": 99.8,
          "p50DurationSeconds": 210,
          "p90DurationSeconds": 372,
          "volumeUsd24h": 45600000
        },
        "pool": {
          "tvlUsd": 85000000,
          "utilization": 23,
          "fragility": "low",
          "fragilityReason": "Pool is stable"
        },
        "lastTransferAt": "2026-02-21T14:34:12Z"
      }
    ],
    "total": 15,
    "limit": 100,
    "offset": 0
  }
}
```

---

### GET /api/corridors/:corridorId

Detailed view of a single corridor.

#### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `corridorId` | string | Corridor identifier (e.g., across_ethereum_arbitrum) |

#### Response

```typescript
interface CorridorDetailResponse {
  corridor: Corridor;
  recentTransfers: Transfer[];      // Last 20
  hourlyStats: HourlyStat[];        // Last 24 hours
  dailyStats: DailyStat[];          // Last 7 days
  anomalies: Anomaly[];             // Active anomalies
}

interface Transfer {
  transferId: string;
  amount: string;                   // Decimal string
  amountUsd: number;
  asset: string;
  status: "pending" | "completed" | "stuck" | "failed";
  initiatedAt: string;
  completedAt?: string;
  durationSeconds?: number;
  txHashSource: string;
  txHashDest?: string;
}

interface HourlyStat {
  hour: string;                     // ISO8601 hour start
  transferCount: number;
  successRate: number | null;       // null when no resolved transfers in bucket
  p50DurationSeconds: number;
  p90DurationSeconds: number;
  volumeUsd: number;
}

interface DailyStat {
  date: string;                     // YYYY-MM-DD
  transferCount: number;
  successRate: number | null;       // null when no resolved transfers in bucket
  avgDurationSeconds: number;
  volumeUsd: number;
  status: "healthy" | "degraded" | "down";
}
```

#### Example

```bash
curl https://corridorscout.com/api/corridors/across_ethereum_arbitrum
```

```json
{
  "data": {
    "corridor": {
      "corridorId": "across_ethereum_arbitrum",
      "bridge": "across",
      "sourceChain": "ethereum",
      "destChain": "arbitrum",
      "status": "healthy",
      "metrics": { ... },
      "pool": { ... },
      "lastTransferAt": "2026-02-21T14:34:12Z"
    },
    "recentTransfers": [
      {
        "transferId": "eth_12345_67890",
        "amount": "10000.000000",
        "amountUsd": 10000,
        "asset": "USDC",
        "status": "completed",
        "initiatedAt": "2026-02-21T14:30:00Z",
        "completedAt": "2026-02-21T14:33:30Z",
        "durationSeconds": 210,
        "txHashSource": "0xabc...",
        "txHashDest": "0xdef..."
      }
    ],
    "hourlyStats": [
      {
        "hour": "2026-02-21T14:00:00Z",
        "transferCount": 47,
        "successRate": 100,
        "p50DurationSeconds": 210,
        "p90DurationSeconds": 372,
        "volumeUsd": 2340000
      }
    ],
    "dailyStats": [
      {
        "date": "2026-02-21",
        "transferCount": 1124,
        "successRate": 99.8,
        "avgDurationSeconds": 245,
        "volumeUsd": 45600000,
        "status": "healthy"
      }
    ],
    "anomalies": []
  }
}
```

---

### GET /api/impact/estimate

Calculate liquidity impact for a potential transfer.

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `bridge` | string | Yes | Bridge protocol |
| `source` | string | Yes | Source chain |
| `dest` | string | Yes | Destination chain |
| `amountUsd` | number | Yes | Transfer amount in USD |

#### Response

```typescript
interface ImpactEstimateResponse {
  corridorId: string;
  transferAmountUsd: number;
  pool: {
    tvlUsd: number;
    utilization: number;
    availableLiquidity: number;
  };
  impact: {
    poolSharePct: number;        // Your transfer as % of pool
    estimatedSlippageBps: number; // Basis points
    impactLevel: "negligible" | "low" | "moderate" | "high" | "severe";
    warning: string | null;
  };
  fragility: {
    current: "low" | "medium" | "high";
    reason: string;
    postTransfer: "low" | "medium" | "high";  // Projected after transfer
  };
  corridorHealth: {
    status: "healthy" | "degraded" | "down";
    p50DurationSeconds: number;
    p90DurationSeconds: number;
    successRate1h: number | null;    // null when no resolved transfers
  };
  recommendation: string | null;   // Actionable advice
  disclaimer: string;              // Always present
}
```

#### Example

```bash
curl "https://corridorscout.com/api/impact/estimate?bridge=across&source=ethereum&dest=arbitrum&amountUsd=5000000"
```

```json
{
  "data": {
    "corridorId": "across_ethereum_arbitrum",
    "transferAmountUsd": 5000000,
    "pool": {
      "tvlUsd": 85000000,
      "utilization": 23.5,
      "availableLiquidity": 65025000
    },
    "impact": {
      "poolSharePct": 5.88,
      "estimatedSlippageBps": 2.9,
      "impactLevel": "moderate",
      "warning": "Your transfer is 5.9% of pool liquidity"
    },
    "fragility": {
      "current": "low",
      "reason": "Pool is stable",
      "postTransfer": "low"
    },
    "corridorHealth": {
      "status": "healthy",
      "p50DurationSeconds": 210,
      "p90DurationSeconds": 372,
      "successRate1h": 100
    },
    "recommendation": null,
    "disclaimer": "Directional estimate only. Not an execution guarantee."
  }
}
```

---

### GET /api/anomalies

List detected anomalies.

#### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `active` | boolean | Only unresolved anomalies (default true) |
| `severity` | string | Filter by severity (low, medium, high) |
| `type` | string | Filter by type (latency_spike, failure_cluster, liquidity_drop, stuck_transfer) |
| `bridge` | string | Filter by bridge |
| `corridorId` | string | Filter by corridor |
| `limit` | number | Max results (default 50) |

#### Response

```typescript
interface AnomaliesResponse {
  anomalies: Anomaly[];
  total: number;
}

interface Anomaly {
  id: string;
  anomalyType: "latency_spike" | "failure_cluster" | "liquidity_drop" | "stuck_transfer";
  corridorId: string;
  bridge: string;
  sourceChain: string;
  destChain: string;
  severity: "low" | "medium" | "high";
  detectedAt: string;
  resolvedAt: string | null;
  details: {
    // Varies by anomaly type
    [key: string]: any;
  };
  description: string;           // Human-readable summary
}
```

#### Example

```bash
curl "https://corridorscout.com/api/anomalies?active=true&severity=high"
```

```json
{
  "data": {
    "anomalies": [
      {
        "id": "anom_123",
        "anomalyType": "latency_spike",
        "corridorId": "stargate_ethereum_avalanche",
        "bridge": "stargate",
        "sourceChain": "ethereum",
        "destChain": "avalanche",
        "severity": "high",
        "detectedAt": "2026-02-21T14:20:00Z",
        "resolvedAt": null,
        "details": {
          "normalP90Seconds": 1800,
          "currentP90Seconds": 12420,
          "multiplier": 6.9,
          "affectedTransfers": 12
        },
        "description": "Latency 6.9x normal on Stargate ETH→AVAX"
      }
    ],
    "total": 2
  }
}
```

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Invalid request parameters |
| `NOT_FOUND` | 404 | Resource not found |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server error |
| `SERVICE_UNAVAILABLE` | 503 | Database or RPC unavailable |

---

## TypeScript SDK (Future)

```typescript
import { CorridorScout } from '@corridorscout/sdk';

const client = new CorridorScout({
  apiKey: 'optional-for-higher-limits'
});

// Get system health
const health = await client.getHealth();

// Get all corridors
const corridors = await client.getCorridors({
  bridge: 'across',
  status: 'healthy'
});

// Calculate impact
const impact = await client.estimateImpact({
  bridge: 'across',
  source: 'ethereum',
  dest: 'arbitrum',
  amountUsd: 5000000
});

// Subscribe to real-time updates
client.subscribe('anomalies', (anomaly) => {
  console.log('New anomaly:', anomaly);
});
```

---

## Webhooks (Future)

```typescript
// POST to your endpoint
{
  "event": "anomaly.created",
  "timestamp": "2026-02-21T14:20:00Z",
  "data": {
    "anomalyId": "anom_123",
    "type": "latency_spike",
    "corridorId": "stargate_ethereum_avalanche",
    "severity": "high"
  }
}
```