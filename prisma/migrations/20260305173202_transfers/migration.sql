-- DropIndex
DROP INDEX "idx_anomalies_active";

-- DropIndex
DROP INDEX "idx_transfers_status";

-- CreateIndex
CREATE INDEX "idx_anomalies_active" ON "anomalies"("corridor_id");

-- CreateIndex
CREATE INDEX "idx_transfers_status" ON "transfers"("status");
