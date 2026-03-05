-- Add asset_raw column to transfers table.
--
-- asset_raw stores the exact on-chain ERC-20 symbol (e.g. 'DAI.e', 'WETH.e')
-- when it differs from the canonical symbol stored in `asset`.
-- NULL means the on-chain symbol matches the canonical symbol exactly.
--
-- This allows:
--   - Aggregation queries to use `asset` (canonical, e.g. 'DAI')
--   - Precision queries to use `asset_raw` (e.g. 'DAI.e' vs native DAI)
--   - Ground truth always available via `token_address`

ALTER TABLE "transfers" ADD COLUMN "asset_raw" TEXT;
