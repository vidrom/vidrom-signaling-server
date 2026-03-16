-- Move door_code from buildings to intercoms
-- Run: psql -h <RDS_ENDPOINT> -U vidrom -d vidrom -f sql/003-move-door-code-to-intercoms.sql

-- 1. Add door_code column to intercoms
ALTER TABLE intercoms
  ADD COLUMN IF NOT EXISTS door_code VARCHAR(20);

-- 2. Copy door_code from each building to its intercoms
UPDATE intercoms i
SET door_code = b.door_code
FROM buildings b
WHERE i.building_id = b.id;

-- 3. Drop door_code from buildings
ALTER TABLE buildings DROP COLUMN IF EXISTS door_code;
