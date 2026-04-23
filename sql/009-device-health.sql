-- 009-device-health.sql

CREATE TABLE IF NOT EXISTS device_health (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_token            TEXT NOT NULL,
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    apartment_id            UUID NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
    platform                VARCHAR(10) NOT NULL CHECK (platform IN ('ios', 'android')),
    token_type              VARCHAR(10) NOT NULL CHECK (token_type IN ('fcm', 'voip')),
    last_successful_push    TIMESTAMPTZ,
    last_push_failure       TIMESTAMPTZ,
    last_push_error         TEXT,
    last_token_refresh      TIMESTAMPTZ,
    last_ack_at             TIMESTAMPTZ,
    last_call_ack_event     VARCHAR(30),
    notification_permission VARCHAR(10) DEFAULT 'unknown' CHECK (notification_permission IN ('granted', 'denied', 'unknown')),
    app_version             VARCHAR(20),
    os_version              VARCHAR(20),
    health_score            INTEGER DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
    health_status           VARCHAR(15) DEFAULT 'unknown' CHECK (health_status IN ('healthy', 'degraded', 'unhealthy', 'unknown')),
    last_evaluated_at       TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_token, token_type)
);

CREATE INDEX idx_device_health_apartment ON device_health (apartment_id);
CREATE INDEX idx_device_health_status ON device_health (health_status);
CREATE INDEX idx_device_health_user ON device_health (user_id);

-- Apartment health summary view with time-based penalties at read time
CREATE OR REPLACE VIEW apartment_device_health AS
WITH scored AS (
    SELECT
        dh.*,
        GREATEST(0, LEAST(100,
            dh.health_score
            - CASE WHEN dh.last_successful_push < NOW() - INTERVAL '7 days' THEN 30 ELSE 0 END
            - CASE WHEN dh.last_token_refresh < NOW() - INTERVAL '30 days' THEN 10 ELSE 0 END
        )) AS live_score
    FROM device_health dh
),
with_status AS (
    SELECT *,
        CASE
            WHEN live_score >= 80 THEN 'healthy'
            WHEN live_score >= 50 THEN 'degraded'
            ELSE 'unhealthy'
        END AS live_status
    FROM scored
)
SELECT
    a.id AS apartment_id,
    a.number AS apartment_number,
    a.building_id,
    COUNT(DISTINCT s.device_token) AS total_devices,
    COUNT(DISTINCT s.device_token) FILTER (WHERE s.live_status = 'healthy') AS healthy_devices,
    COUNT(DISTINCT s.device_token) FILTER (WHERE s.live_status = 'degraded') AS degraded_devices,
    COUNT(DISTINCT s.device_token) FILTER (WHERE s.live_status = 'unhealthy') AS unhealthy_devices,
    CASE
        WHEN COUNT(DISTINCT s.device_token) = 0 THEN 'no-devices'
        WHEN COUNT(DISTINCT s.device_token) FILTER (WHERE s.live_status = 'healthy') > 0 THEN 'ok'
        WHEN COUNT(DISTINCT s.device_token) FILTER (WHERE s.live_status = 'degraded') > 0 THEN 'at-risk'
        ELSE 'critical'
    END AS apartment_health
FROM apartments a
LEFT JOIN with_status s ON s.apartment_id = a.id
GROUP BY a.id, a.number, a.building_id;
