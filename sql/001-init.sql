-- Vidrom Database Schema - Initial Migration
-- PostgreSQL 16
-- Run: psql -h <RDS_ENDPOINT> -U vidrom -d vidrom -f sql/001-init.sql

-- ════════════════════════════════════════════════════════════════
-- Tables
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS buildings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    address         VARCHAR(500) NOT NULL,
    door_code       VARCHAR(20)  NOT NULL,
    door_opening_time INTEGER    NOT NULL DEFAULT 5,
    no_answer_timeout INTEGER    NOT NULL DEFAULT 30,
    language        VARCHAR(10)  NOT NULL DEFAULT 'en',
    volume          INTEGER      NOT NULL DEFAULT 50 CHECK (volume BETWEEN 0 AND 100),
    brightness      INTEGER      NOT NULL DEFAULT 50 CHECK (brightness BETWEEN 0 AND 100),
    dark_mode       BOOLEAN      NOT NULL DEFAULT false,
    sleep_mode      BOOLEAN      NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_buildings_name ON buildings (name);

-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS apartments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    building_id     UUID         NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    number          VARCHAR(20)  NOT NULL,
    name            VARCHAR(255),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apartments_building_id ON apartments (building_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_apartments_building_number ON apartments (building_id, number);

-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                    VARCHAR(255) NOT NULL UNIQUE,
    name                     VARCHAR(255) NOT NULL,
    role                     VARCHAR(20)  NOT NULL CHECK (role IN ('admin', 'manager', 'resident')),
    push_notification_token  VARCHAR(500),
    authentication_method    VARCHAR(20)  CHECK (authentication_method IN ('google', 'apple')),
    sleep_mode               BOOLEAN      NOT NULL DEFAULT false,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS intercoms (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    building_id     UUID         NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    gate_id         VARCHAR(50),
    status          VARCHAR(20)  NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected')),
    provisioning_code   VARCHAR(10),
    provisioning_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (provisioning_status IN ('pending', 'active', 'revoked')),
    is_door_open    BOOLEAN      NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intercoms_building_id ON intercoms (building_id);
CREATE INDEX IF NOT EXISTS idx_intercoms_status ON intercoms (status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_intercoms_provisioning_code ON intercoms (provisioning_code) WHERE provisioning_code IS NOT NULL;

-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calls (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    building_id     UUID         NOT NULL REFERENCES buildings(id),
    apartment_id    UUID         NOT NULL REFERENCES apartments(id),
    intercom_id     UUID         NOT NULL REFERENCES intercoms(id),
    status          VARCHAR(20)  NOT NULL DEFAULT 'calling' CHECK (status IN ('calling', 'accepted', 'ended', 'rejected', 'unanswered')),
    started_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calls_building_id ON calls (building_id);
CREATE INDEX IF NOT EXISTS idx_calls_apartment_id ON calls (apartment_id);
CREATE INDEX IF NOT EXISTS idx_calls_intercom_id ON calls (intercom_id);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls (status);
CREATE INDEX IF NOT EXISTS idx_calls_active ON calls (apartment_id) WHERE status IN ('calling', 'accepted');

-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    building_id     UUID         NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    text            TEXT         NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_building_id ON notifications (building_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at DESC);

-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      VARCHAR(30) NOT NULL CHECK (event_type IN (
        'call-initiated', 'call-accepted', 'call-rejected', 'call-ended',
        'call-unanswered', 'door-open', 'access-code-success',
        'access-code-failure', 'watch-camera-started'
    )),
    building_id     UUID REFERENCES buildings(id),
    apartment_id    UUID REFERENCES apartments(id),
    user_id         UUID REFERENCES users(id),
    intercom_id     UUID REFERENCES intercoms(id),
    call_id         UUID REFERENCES calls(id),
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON audit_logs (event_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_building_id ON audit_logs (building_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_call_id ON audit_logs (call_id) WHERE call_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS global_settings (
    key             VARCHAR(100) PRIMARY KEY,
    value           VARCHAR(255) NOT NULL,
    description     TEXT,
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════════
-- Junction Tables
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS apartment_residents (
    apartment_id    UUID NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (apartment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_apartment_residents_user_id ON apartment_residents (user_id);

-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS building_managers (
    building_id     UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (building_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_building_managers_user_id ON building_managers (user_id);

-- ════════════════════════════════════════════════════════════════
-- Auto-update Trigger
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_buildings_updated_at BEFORE UPDATE ON buildings FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_apartments_updated_at BEFORE UPDATE ON apartments FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_intercoms_updated_at BEFORE UPDATE ON intercoms FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_calls_updated_at BEFORE UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_global_settings_updated_at BEFORE UPDATE ON global_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ════════════════════════════════════════════════════════════════
-- Seed Data
-- ════════════════════════════════════════════════════════════════

INSERT INTO global_settings (key, value, description) VALUES
    ('max_call_duration',        '60', 'Maximum duration allowed for a call (seconds)'),
    ('no_answer_timeout',        '30', 'Default duration before an unanswered call auto-ends (seconds)'),
    ('call_polling_interval',    '3',  'How often to poll for call status (seconds)'),
    ('intercom_polling_interval','2',  'How often to poll intercom status (seconds)')
ON CONFLICT (key) DO NOTHING;
