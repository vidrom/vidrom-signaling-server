-- Migration 007: Persistent call delivery attempts
-- Tracks push delivery state per device per call so ringing survives server restart.

CREATE TABLE IF NOT EXISTS call_delivery_attempts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id           UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
    device_token      TEXT NOT NULL,
    token_type        VARCHAR(10) NOT NULL CHECK (token_type IN ('fcm', 'voip')),
    platform          VARCHAR(10) NOT NULL CHECK (platform IN ('ios', 'android')),
    attempt_number    INTEGER NOT NULL DEFAULT 1,
    delivery_state    VARCHAR(30) NOT NULL DEFAULT 'queued'
                      CHECK (delivery_state IN (
                          'queued', 'push-sent', 'push-failed',
                          'push-received', 'app-awake', 'incoming-ui-shown',
                          'accepted', 'declined', 'timed-out',
                          'skipped-sleep-mode'
                      )),
    last_error        TEXT,
    last_attempt_at   TIMESTAMPTZ,
    acked_at          TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_call_delivery_attempts_call ON call_delivery_attempts (call_id);
CREATE INDEX idx_call_delivery_attempts_state ON call_delivery_attempts (call_id, delivery_state);

-- Add expires_at to calls so the server knows when a ring should time out, even after restart
ALTER TABLE calls ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
