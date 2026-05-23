ALTER TABLE users
ADD COLUMN IF NOT EXISTS google_subject VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google_subject
ON users (google_subject)
WHERE google_subject IS NOT NULL;