-- Add provisioning support to intercoms table
-- Run: psql -h <RDS_ENDPOINT> -U vidrom -d vidrom -f sql/002-intercom-provisioning.sql

ALTER TABLE intercoms
  ADD COLUMN IF NOT EXISTS provisioning_code   VARCHAR(10),
  ADD COLUMN IF NOT EXISTS provisioning_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (provisioning_status IN ('pending', 'active', 'revoked'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_intercoms_provisioning_code
  ON intercoms (provisioning_code) WHERE provisioning_code IS NOT NULL;
