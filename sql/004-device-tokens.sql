-- Device token storage for per-apartment push notification routing
-- Supports multiple residents per apartment (max 10), each with their own device tokens

CREATE TABLE IF NOT EXISTS device_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    apartment_id    UUID         NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
    user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token           TEXT         NOT NULL,
    token_type      VARCHAR(10)  NOT NULL CHECK (token_type IN ('fcm', 'voip')),
    platform        VARCHAR(10)  NOT NULL CHECK (platform IN ('ios', 'android')),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- A given push token is unique per type (a device can't have two FCM registrations)
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_tokens_token_type ON device_tokens (token, token_type);

-- Fast lookup: all tokens for an apartment (used during ring)
CREATE INDEX IF NOT EXISTS idx_device_tokens_apartment ON device_tokens (apartment_id);

-- Fast lookup: tokens for a specific user (used during token refresh/cleanup)
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens (user_id);
