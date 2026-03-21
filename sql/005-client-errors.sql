-- Client error logging table
-- Stores errors reported by home and intercom apps for investigation

CREATE TABLE IF NOT EXISTS client_errors (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app             VARCHAR(20)  NOT NULL CHECK (app IN ('home', 'intercom')),
    error_type      VARCHAR(100) NOT NULL,
    message         TEXT         NOT NULL,
    stack           TEXT,
    context         JSONB,
    -- Device info
    platform        VARCHAR(10),
    os_version      VARCHAR(30),
    app_version     VARCHAR(30),
    device_model    VARCHAR(100),
    -- User/building context
    user_id         UUID         REFERENCES users(id) ON DELETE SET NULL,
    user_email      VARCHAR(255),
    apartment_id    UUID         REFERENCES apartments(id) ON DELETE SET NULL,
    building_id     UUID         REFERENCES buildings(id) ON DELETE SET NULL,
    intercom_id     UUID         REFERENCES intercoms(id) ON DELETE SET NULL,
    -- Timestamps
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Fast lookup by app and time (most common admin query)
CREATE INDEX IF NOT EXISTS idx_client_errors_app_time ON client_errors (app, created_at DESC);

-- Filter by building
CREATE INDEX IF NOT EXISTS idx_client_errors_building ON client_errors (building_id, created_at DESC);
