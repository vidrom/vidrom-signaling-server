CREATE TABLE IF NOT EXISTS call_delivery_acks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id         UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    device_token    TEXT NOT NULL,
    token_type      VARCHAR(10) NOT NULL CHECK (token_type IN ('fcm', 'voip')),
    platform        VARCHAR(10) NOT NULL CHECK (platform IN ('ios', 'android')),
    event           VARCHAR(30) NOT NULL CHECK (event IN (
        'push-received', 'app-awake', 'incoming-ui-shown', 'accepted', 'declined'
    )),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_call_delivery_acks_call ON call_delivery_acks (call_id);
CREATE INDEX idx_call_delivery_acks_event ON call_delivery_acks (call_id, event);
