ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_event_type_check;

ALTER TABLE audit_logs
ADD CONSTRAINT audit_logs_event_type_check CHECK (event_type IN (
    'call-initiated', 'call-accepted', 'call-rejected', 'call-ended',
    'call-unanswered', 'accept-timeout', 'door-open', 'access-code-success',
    'access-code-failure', 'watch-camera-started', 'late-join-ring',
    'late-join-call-taken', 'ring-skipped-sleep-mode', 'delivery-degraded'
));