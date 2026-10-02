ALTER TABLE "alert_incidents" ADD COLUMN "lease_owner" TEXT;
ALTER TABLE "alert_incidents" ADD COLUMN "lease_token" TEXT;
ALTER TABLE "alert_incidents" ADD COLUMN "lease_expires_at" TEXT;
CREATE INDEX "alert_incidents_lease_expires_at_idx" ON "alert_incidents" ("lease_expires_at");
