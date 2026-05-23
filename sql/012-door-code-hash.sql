-- Step 16: store intercom door codes as salted PBKDF2 hashes.
-- Existing plaintext door_code values remain temporarily for backward-compatible
-- runtime migration on the next successful verification or admin update.
-- Run after deploying code that reads door_code_hash.

ALTER TABLE intercoms
  ADD COLUMN IF NOT EXISTS door_code_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_intercoms_door_code_hash_present
  ON intercoms (id)
  WHERE door_code_hash IS NOT NULL;
