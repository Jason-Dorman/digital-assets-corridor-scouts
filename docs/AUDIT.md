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