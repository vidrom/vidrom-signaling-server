-- 008: Delivery summary view — aggregates per-call delivery data for audit dashboards
CREATE OR REPLACE VIEW call_delivery_summary AS
SELECT
    c.id AS call_id,
    c.building_id,
    c.apartment_id,
    c.intercom_id,
    c.status AS call_status,
    c.created_at AS call_started_at,
    c.ended_at AS call_ended_at,
    COUNT(DISTINCT cda.device_token) AS devices_targeted,
    COUNT(DISTINCT cda.device_token) FILTER (WHERE cda.delivery_state IN ('push-received', 'app-awake', 'incoming-ui-shown', 'accepted')) AS devices_acked,
    COUNT(DISTINCT cda.device_token) FILTER (WHERE cda.delivery_state = 'push-failed') AS devices_failed,
    COUNT(DISTINCT cda.device_token) FILTER (WHERE cda.delivery_state = 'timed-out') AS devices_timed_out,
    COUNT(DISTINCT cda.device_token) FILTER (WHERE cda.delivery_state = 'skipped-sleep-mode') AS devices_skipped_sleep,
    MAX(cda.attempt_number) AS max_retries,
    MIN(cdacks.created_at) FILTER (WHERE cdacks.event = 'push-received') AS first_ack_at,
    EXTRACT(EPOCH FROM (MIN(cdacks.created_at) FILTER (WHERE cdacks.event = 'push-received') - c.created_at)) AS first_ack_latency_sec
FROM calls c
LEFT JOIN call_delivery_attempts cda ON cda.call_id = c.id
LEFT JOIN call_delivery_acks cdacks ON cdacks.call_id = c.id
GROUP BY c.id;
