ALTER TABLE users
ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_firebase_uid
ON users (firebase_uid)
WHERE firebase_uid IS NOT NULL;