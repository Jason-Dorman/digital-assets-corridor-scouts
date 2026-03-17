## Open Questions - Needs Verification

### Across Liquidity Architecture
**Question:** For impact calculation, should we use HubPool liquidity or SpokePool liquidity?

**Current understanding:**
- HubPool (Ethereum): Main liquidity source, has utilization data
- SpokePools (per chain): Smaller amounts, possibly relayer liquidity

**Why it matters:**
- Impact calculator needs to know "how much liquidity is actually available for this transfer"
- Using wrong pool could give misleading impact assessment
- $5M transfer against $1.4M HubPool = severe impact
- $5M transfer against $54K SpokePool = ??? (is this even the right comparison?)

**Action needed:** Research Across docs or ask Across team how liquidity flows work for large transfers

**Status:** Unresolved

---

## Stargate Integration — On Hold

**Decision:** Stargate scout is deferred. Code exists on `feature/stargate-scout` branch but is not merged to main. Resume from `docs/PROMPTS.md` Prompt 3.2.

**Why it's blocked:** All Stargate contract addresses in `src/lib/constants.ts` are unverified stubs. They must be confirmed against the official Stargate docs before the scout can be activated safely.

---

### What needs verification

#### Router Addresses (`STARGATE_ROUTER_ADDRESSES` in `constants.ts:268`)
All five entries are marked `// TODO: verify`:

| Chain | Current Address | Verify at |
|-------|----------------|-----------|
| Ethereum | `0x8731d54E9D02c286767d56ac03e8037C07e01e98` | [Stargate mainnet contracts](https://stargateprotocol.gitbook.io/stargate/developers/contract-addresses/mainnet) |
| Arbitrum | `0x53Bf833A5d6c4ddA888F69c22C88C9f356a41614` | same |
| Optimism | `0xB0D502E938ed5f4df2E681fE6E419ff29631d62b` | same |
| Avalanche | `0x45A01E4e04F14f7A4a6702c74187c5F6222033cd` | same |
| Polygon | `0x45A01E4e04F14f7A4a6702c74187c5F6222033cd` | same — note: Avalanche and Polygon share the same address, which is suspicious |

#### Pool Contract Addresses (`STARGATE_POOL_ADDRESSES` in `constants.ts:285`)
All entries are marked `// TODO: verify`. These are the contracts that emit the `Swap` events the scout actually listens to:

| Chain | Pool 1 (USDC) | Pool 2 (USDT) |
|-------|--------------|--------------|
| Ethereum | `0xdf0770dF86a8034b3EFEf0A1Bb3c889B8332FF56` | `0x38EA452219524Bb87e18dE1C24D3bB59510BD783` |
| Arbitrum | `0x892785f33CdeE22A30AEF750F285E18c18040c3e` | `0xB6CfcF89a7B22988bfC96632aC2A9D6daB60d641` |
| Optimism | `0xDecC0c09c3B5f6e92EF4184125D5648a66E35298` | `0x165137624F1f692e69659f944BF69DE02874ee27` |
| Avalanche | `0x1205f31718499dBf1fCa446663B532Ef87481fe1` | `0x29e38769f23701A2e4A8Ef0492e19dA4604Be62c` |
| Polygon | `0x1205f31718499dBf1fCa446663B532Ef87481fe1` | `0x29e38769f23701A2e4A8Ef0492e19dA4604Be62c` |

> **Note:** Avalanche and Polygon share the same pool addresses — same issue as the Router. Needs investigation; they likely differ.

#### Stargate Internal Chain IDs (`STARGATE_CHAIN_IDS` in `constants.ts:250`)
These are Stargate's own chain IDs (not EVM IDs), used to decode the `chainId` field in `Swap` events:

| Stargate ID | Mapped to | Verify |
|-------------|-----------|--------|
| 101 | ethereum | [same docs link](https://stargateprotocol.gitbook.io/stargate/developers/contract-addresses/mainnet) |
| 110 | arbitrum | |
| 111 | optimism | |
| 106 | avalanche | |
| 109 | polygon | |

#### Token Addresses (`STARGATE_POOL_TOKEN_ADDRESSES` in `constants.ts:315`)
These are not marked TODO but were sourced from `DATA-MODEL.md §3.2` (internal doc) rather than on-chain verification. Worth a spot-check:

| Chain | Pool 1 = USDC | Pool 2 = USDT |
|-------|--------------|--------------|
| Ethereum | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` | `0xdac17f958d2ee523a2206206994597c13d831ec7` |
| Arbitrum | `0xaf88d065e77c8cc2239327c5edb3a432268e5831` | `0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9` |
| Optimism | `0x0b2c639c533813f4aa9d7837caf62653d097ff85` | `0x94b008aa00579c1307b0ef2c499ad98a8ce58e58` |
| Avalanche | `0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e` | `0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7` |
| Polygon | `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359` | `0xc2132d05d31c914a87c6611c10748aeb04b58e8f` |

---

### Known design limitations to address when resuming

1. **No fill/completion detection — produces junk data:** `parseFillEvent` returns `null`, meaning every Stargate transfer will be marked `stuck` after 30 min. This isn't a temporary data gap — it actively pollutes the stuck/failure metrics for the corridor. Do not activate the scout without resolving this first.

   **Options identified:**
   - **Option A — Destination chain completion event:** Stargate does emit completion events on the destination chain, likely `SwapRemote` or similar on the destination Pool contract. Need to identify the correct event signature and implement cross-chain matching (source `Swap` → destination `SwapRemote`).
   - **Option B — Stargate V2:** V2 may have cleaner, more symmetric events. Worth evaluating before investing in V1 completion detection, especially given V1's age.

2. **Router address used for BaseScout compliance only:** `getContractAddress()` returns the Router address to satisfy the abstract interface, but the scout actually listens on individual Pool contracts. This is intentional (Liskov Substitution) but worth flagging so future devs don't wonder why the Router address is in there.

3. **`amountSD` passed raw:** The `Swap` event amount is in shared decimals (6 dp for stablecoins). The pool processor is responsible for normalising — make sure that's handled before activating.

4. **Base chain not supported:** Stargate V1 chains are `ethereum, arbitrum, optimism, avalanche, polygon`. Base is notably absent. Confirm whether Stargate V1 deployed on Base or if V2 is needed.

---

### How to resume

1. Verify all addresses in the tables above against [Stargate mainnet contracts](https://stargateprotocol.gitbook.io/stargate/developers/contract-addresses/mainnet)
2. Fix the duplicate Avalanche/Polygon Router and Pool addresses if confirmed wrong
3. Update `constants.ts` and remove all `// TODO: verify` comments
4. Follow `docs/PROMPTS.md` Prompt 3.2 to complete the implementation
5. Implement the pool snapshot processor for Stargate pools (Prompt 3.3 references this)
6. Consider whether Stargate V2 is preferable to V1 given the current state of the protocol

**Status:** Blocked on address verification

---

### Missing Reconciliation Job

**Issue:** Completion events that arrive without a matching initiation in memory or the database are logged as warnings and silently dropped (`TransferProcessor.handleCompletion`, line ~124).

**When this happens:** The processor restarts between a transfer's initiation and its completion. The initiation was saved to the DB, but the in-memory `pendingTransfers` map is cleared on restart. If the completion event is replayed before the processor re-observes the initiation log, the lookup returns nothing and the event is discarded.

**Impact:** Affected transfers remain permanently `pending` in the DB. `durationSeconds`, `completedAt`, and `txHashDest` are never written. This skews latency metrics and inflates the apparent stuck-transfer rate for the corridor.

**Fix:** A reconciliation job that periodically scans the chain for fill/completion events matching transfers that are `pending` and older than the bridge's stuck threshold. This requires historical log indexing (e.g. `eth_getLogs` with block range).

**Priority:** Post-Phase 0. Build once the happy-path pipeline is stable and producing real data. Blocked on: deciding whether to run as a Vercel cron, a standalone worker, or a one-off backfill script.

---

## Code Review Findings — 2026-03-16

Issues identified during the Phase 0 code review (through prompt 3.3). Issues #1–#8 were fixed immediately. Issues #9–#14 are tracked here for resolution before or during Phase 1.

---

### #6 — `HEALTH_THRESHOLDS` missing the degraded success rate boundary

**File:** `src/lib/constants.ts`

**Issue:** `SUCCESS_RATE_HEALTHY: 99` and `SUCCESS_RATE_DOWN: 95` are defined, but there is no constant for the degraded boundary. The 95–99% range is implicit. Any health calculator must hard-code the logic `< HEALTHY && >= DOWN → degraded`, which is fragile and untested.

**Fix:** Add `SUCCESS_RATE_DEGRADED` as an explicit constant (value: 95, same as `SUCCESS_RATE_DOWN`) or rename the existing constants to make the three-way split unambiguous. Update the health calculator and its tests to assert against the named constant.

**Priority:** Before health calculator is implemented.

---

### #7 — Dead bridge entries in `STUCK_THRESHOLDS_SECONDS` and `SLIPPAGE_FACTORS`

**File:** `src/lib/constants.ts`

**Issue:** Both maps include `wormhole` and `layerzero` keys that are not in `BRIDGES`. They will never be used and the `Record<string, number>` type means typos in callers silently return `undefined` instead of a type error.

**Fix:** Remove the dead entries. Type both maps as `Record<BridgeName, number>` so the TypeScript compiler catches any unsupported bridge name at the call site.

**Priority:** Low — no runtime impact, but misleading.

---

### #8 — Duplicate `CHAIN_ID_TO_NAME` reverse-lookup map in `across.ts` and `cctp.ts`

**Files:** `src/scouts/across.ts`, `src/scouts/cctp.ts`

**Issue:** Both scouts define an identical module-level `CHAIN_ID_TO_NAME` Map built from `CHAIN_IDS`. Stargate will need the same map when activated. Any future chain addition must be reflected in three places.

**Fix:** Export `CHAIN_ID_TO_NAME` from `src/lib/constants.ts` and import it in each scout. One source of truth.

**Priority:** Low — fix before Stargate is activated to avoid a third copy.

---

### #9 — Wall-clock fallback in `getBlockTimestamp` can silently corrupt `durationSeconds`

**File:** `src/scouts/base.ts`

**Issue:** When `provider.getBlock()` returns `null` or throws, the fallback is `new Date()` (wall-clock time). If an initiation uses a real block timestamp and its completion uses a wall-clock fallback (or vice versa), `durationSeconds` in the database will be wildly wrong. Currently the fallback is silent — there is no log entry that would let an operator identify the affected transfer.

**Fix:** Add a `console.warn` with the `transferId`, chain, and block number whenever the fallback is used. Consider also writing a `timestampSource: 'block' | 'fallback'` flag to the database so corrupted durations can be filtered out of latency metrics.

**Priority:** Medium — log the warning at minimum before ingesting real data.

---

### #10 — CCTP `availableLiquidity: 0` is semantically ambiguous in `PoolProcessor`

**File:** `src/processors/pool.ts`

**Issue:** CCTP placeholder rows are written with `availableLiquidity: 0`. For Across SpokePools, `availableLiquidity: 0` means the pool is fully utilized (no capital available). For CCTP, it means the concept doesn't apply. Queries doing `WHERE available_liquidity = 0` cannot distinguish between the two cases.

**Fix:** Use `availableLiquidity: null` for CCTP placeholders to represent "not applicable", consistent with how `utilization: null` represents "cannot be computed" for SpokePool rows.

**Priority:** Low — fix before LFV queries are written to avoid building logic on a misleading zero.

---

### #11 — Sequential DB writes in `PoolProcessor.enrichAndStore`

**File:** `src/processors/pool.ts`

**Issue:** Pool snapshots are written in a serial `for` loop. At 23 rows and ~50ms/round-trip, each snapshot run takes ~1.15 seconds. This is well within the 5-minute cron interval now, but will become a bottleneck if more bridges or assets are added.

**Fix:** Replace the serial loop with `Promise.allSettled()` of parallel `db.poolSnapshot.create()` calls. The same per-row error isolation is preserved since `allSettled` never short-circuits.

**Priority:** Low — no correctness impact, purely a performance improvement. Fix before adding a third bridge with significant pool count.

---

### #12 — `SIZE_BUCKET_THRESHOLDS` key names are semantically reversed

**File:** `src/lib/constants.ts`

**Issue:** The keys `small`, `medium`, `large` store upper bounds for those buckets (e.g., `small: 10_000` means "upper bound of small is $10K"), not representative values. This is counter-intuitive: a reader expects `small` to mean "the small threshold" not "the boundary above small". The logic in `getSizeBucket` is correct but maintainers are likely to misread the constant's intent.

**Fix:** Rename keys to `MEDIUM_MIN`, `LARGE_MIN`, `WHALE_MIN` to make clear they are lower bounds of the upper bucket, or document the convention explicitly in the object comment.

**Priority:** Low — readability only.

---

### #13 — `stop()` does not enforce `isRunning = false` in `BaseScout`

**File:** `src/scouts/base.ts`

**Issue:** `stop()` is abstract, so each subclass is responsible for setting `this.isRunning = false`. Both `AcrossScout` and `CCTPScout` do this correctly, but there is no base-class enforcement. A future scout that omits this line will silently fail to allow restart without a process restart.

**Fix:** Add a `protected stopCleanup(): void` concrete method in `BaseScout` that clears `eventListeners` and sets `isRunning = false`. Each subclass `stop()` calls `this.stopCleanup()` after its own teardown.

**Priority:** Low — fix before a third scout is added to reduce the chance of a future bug.

---

### #14 — `Anomaly` model has no `updatedAt`

**File:** `prisma/schema.prisma`

**Issue:** `Anomaly` rows can be mutated (the `resolvedAt` field is written when an anomaly is resolved), but there is no `updatedAt` field. Operators cannot query "anomalies modified in the last hour" without relying on `resolvedAt`, which is only set once and does not cover edits to `details` or `severity`.

**Fix:** Add `updatedAt DateTime @updatedAt @map("updated_at")` to the `Anomaly` model.

**Priority:** Low — add before the anomaly-detector job writes its first real data.