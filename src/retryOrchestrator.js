// Retry orchestrator — resends push notifications to devices that haven't acked
//
// After the initial ring at t=0, schedules retry checks at t=3s and t=8s.
// At t=15s performs a final check and logs delivery-degraded if zero acks.
// Retry intervals are capped to the building's no_answer_timeout.

const admin = require('firebase-admin');
const { query } = require('./db');
const { sendVoipPush, isAPNsReady } = require('./apnsService');
const { getIntercom } = require('./connectionState');
const { computeDeviceHealth } = require('./deviceHealthScore');

// callId → { timers: [timeout...], cancelled: boolean }
const retryState = new Map();

// Default retry schedule (seconds after ring start)
const RETRY_SCHEDULE = [3, 8];
const FINAL_CHECK_SEC = 15;

async function upsertDeviceHealthSignal({
  deviceToken,
  tokenType,
  userId,
  apartmentId,
  platform,
  lastSuccessfulPush,
  lastPushFailure,
  lastPushError,
}) {
  if (!deviceToken || !tokenType) return;

  const existingResult = await query(
    `SELECT * FROM device_health WHERE device_token = $1 AND token_type = $2 LIMIT 1`,
    [deviceToken, tokenType]
  );
  const existing = existingResult.rows[0] || null;

  const merged = {
    user_id: userId || existing?.user_id || null,
    apartment_id: apartmentId || existing?.apartment_id || null,
    platform: platform || existing?.platform || (tokenType === 'voip' ? 'ios' : 'android'),
    last_successful_push: lastSuccessfulPush !== undefined ? lastSuccessfulPush : (existing?.last_successful_push || null),
    last_push_failure: lastPushFailure !== undefined ? lastPushFailure : (existing?.last_push_failure || null),
    last_push_error: lastPushError !== undefined ? lastPushError : (existing?.last_push_error || null),
    last_token_refresh: existing?.last_token_refresh || null,
    last_ack_at: existing?.last_ack_at || null,
    last_call_ack_event: existing?.last_call_ack_event || null,
    notification_permission: existing?.notification_permission || 'unknown',
    app_version: existing?.app_version || null,
    os_version: existing?.os_version || null,
  };

  if (!merged.user_id || !merged.apartment_id || !merged.platform) {
    return;
  }

  let hasAnyAck = !!merged.last_ack_at;
  if (!hasAnyAck) {
    const ackResult = await query(
      `SELECT 1 FROM call_delivery_acks WHERE device_token = $1 LIMIT 1`,
      [deviceToken]
    );
    hasAnyAck = ackResult.rows.length > 0;
  }

  const { health_score, health_status } = computeDeviceHealth({
    lastPushFailed: !!merged.last_push_failure,
    lastAckAt: merged.last_ack_at,
    notificationPermission: merged.notification_permission,
    hasAnyAck,
  });

  await query(
    `INSERT INTO device_health (
      device_token, token_type, user_id, apartment_id, platform,
      last_successful_push, last_push_failure, last_push_error,
      last_token_refresh, last_ack_at, last_call_ack_event,
      notification_permission, app_version, os_version,
      health_score, health_status, last_evaluated_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9, $10, $11,
      $12, $13, $14,
      $15, $16, NOW(), NOW()
    )
    ON CONFLICT (device_token, token_type) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      apartment_id = EXCLUDED.apartment_id,
      platform = EXCLUDED.platform,
      last_successful_push = EXCLUDED.last_successful_push,
      last_push_failure = EXCLUDED.last_push_failure,
      last_push_error = EXCLUDED.last_push_error,
      last_token_refresh = EXCLUDED.last_token_refresh,
      last_ack_at = EXCLUDED.last_ack_at,
      last_call_ack_event = EXCLUDED.last_call_ack_event,
      notification_permission = EXCLUDED.notification_permission,
      app_version = EXCLUDED.app_version,
      os_version = EXCLUDED.os_version,
      health_score = EXCLUDED.health_score,
      health_status = EXCLUDED.health_status,
      last_evaluated_at = NOW(),
      updated_at = NOW()`,
    [
      deviceToken,
      tokenType,
      merged.user_id,
      merged.apartment_id,
      merged.platform,
      merged.last_successful_push,
      merged.last_push_failure,
      merged.last_push_error,
      merged.last_token_refresh,
      merged.last_ack_at,
      merged.last_call_ack_event,
      merged.notification_permission,
      merged.app_version,
      merged.os_version,
      health_score,
      health_status,
    ]
  );
}

/**
 * Start retry orchestration for a call.
 * Schedules retry pushes for devices that haven't acked within the retry intervals.
 *
 * @param {string} callId
 * @param {number} ringTimeoutSec - building no_answer_timeout
 */
function startRetries(callId, ringTimeoutSec) {
  cancelRetries(callId);

  const entry = { timers: [], cancelled: false };
  retryState.set(callId, entry);

  // Schedule retry pushes at each interval that fits within the ring timeout
  for (const delaySec of RETRY_SCHEDULE) {
    if (delaySec >= ringTimeoutSec) break; // don't retry past the ring timeout
    const timer = setTimeout(() => {
      if (entry.cancelled) return;
      retryUnackedDevices(callId, delaySec);
    }, delaySec * 1000);
    entry.timers.push(timer);
  }

  // Schedule final degraded check if it fits
  if (FINAL_CHECK_SEC < ringTimeoutSec) {
    const finalTimer = setTimeout(() => {
      if (entry.cancelled) return;
      checkDeliveryDegraded(callId);
      // Clean up after final check
      retryState.delete(callId);
    }, FINAL_CHECK_SEC * 1000);
    entry.timers.push(finalTimer);
  }
}

/**
 * Cancel all pending retries for a call (on accept, decline, hangup, timeout).
 */
function cancelRetries(callId) {
  const entry = retryState.get(callId);
  if (!entry) return;
  entry.cancelled = true;
  for (const timer of entry.timers) {
    clearTimeout(timer);
  }
  retryState.delete(callId);
}

/**
 * Resend push to devices that still have delivery_state = 'push-sent' (never acked).
 */
async function retryUnackedDevices(callId, delaySec) {
  try {
    // Find devices that were pushed but never acked
    const result = await query(
      `SELECT cda.device_token, cda.token_type, cda.platform, cda.user_id,
              cda.attempt_number
       FROM call_delivery_attempts cda
       WHERE cda.call_id = $1
         AND cda.delivery_state = 'push-sent'
         AND cda.attempt_number = (
           SELECT MAX(cda2.attempt_number) FROM call_delivery_attempts cda2
           WHERE cda2.call_id = cda.call_id AND cda2.device_token = cda.device_token
         )`,
      [callId]
    );

    if (result.rows.length === 0) {
      console.log(`[RETRY] call=${callId} t=${delaySec}s — all devices acked, no retry needed`);
      return;
    }

    // Get ring timeout for push TTL
    const callResult = await query(
      `SELECT c.expires_at, c.status, c.apartment_id
       FROM calls c WHERE c.id = $1`,
      [callId]
    );
    if (callResult.rows.length === 0 || callResult.rows[0].status !== 'calling') {
      console.log(`[RETRY] call=${callId} no longer active, skipping retry`);
      return;
    }

    const remainingSec = Math.max(1, Math.round(
      (new Date(callResult.rows[0].expires_at).getTime() - Date.now()) / 1000
    ));
    const apartmentId = callResult.rows[0].apartment_id;

    console.log(`[RETRY] call=${callId} t=${delaySec}s — retrying ${result.rows.length} unacked device(s)`);

    for (const row of result.rows) {
      const newAttempt = row.attempt_number + 1;

      // Insert new delivery attempt row
      query(
        `INSERT INTO call_delivery_attempts (call_id, user_id, device_token, token_type, platform, delivery_state, attempt_number)
         VALUES ($1, $2, $3, $4, $5, 'queued', $6)`,
        [callId, row.user_id, row.device_token, row.token_type, row.platform, newAttempt]
      ).catch(e => console.error(`[RETRY] Error inserting retry attempt:`, e.message));

      if (row.token_type === 'voip' && isAPNsReady()) {
        sendVoipPush(row.device_token, 'Intercom', {
          callerName: 'Intercom', type: 'incoming-call', callId,
        }, remainingSec)
          .then((pushResult) => {
            const state = pushResult.success ? 'push-sent' : 'push-failed';
            query(
              `UPDATE call_delivery_attempts SET delivery_state = $1, last_attempt_at = NOW(), last_error = $4
               WHERE call_id = $2 AND device_token = $3 AND attempt_number = (
                 SELECT MAX(attempt_number) FROM call_delivery_attempts WHERE call_id = $2 AND device_token = $3
               )`,
              [state, callId, row.device_token, pushResult.success ? null : pushResult.reason]
            ).catch(e => console.error(`[RETRY] Error updating retry attempt:`, e.message));
            if (pushResult.success) {
              upsertDeviceHealthSignal({
                deviceToken: row.device_token,
                tokenType: row.token_type,
                userId: row.user_id || null,
                apartmentId,
                platform: row.platform || 'ios',
                lastSuccessfulPush: new Date(),
                lastPushFailure: null,
                lastPushError: null,
              }).catch(e => console.error(`[RETRY] Error upserting device health:`, e.message));
              console.log(`[RETRY] VoIP retry push sent (call=${callId}, attempt=${newAttempt})`);
            } else {
              upsertDeviceHealthSignal({
                deviceToken: row.device_token,
                tokenType: row.token_type,
                userId: row.user_id || null,
                apartmentId,
                platform: row.platform || 'ios',
                lastPushFailure: new Date(),
                lastPushError: pushResult.reason || 'push-failed',
              }).catch(e => console.error(`[RETRY] Error upserting device health:`, e.message));
              if (pushResult.reason === 'BadDeviceToken' || pushResult.reason === 'Unregistered') {
                query("DELETE FROM device_tokens WHERE token = $1 AND token_type = 'voip'", [row.device_token])
                  .then(() => console.log('[RETRY] Deleted stale VoIP token'))
                  .catch((e) => console.error('[RETRY] Failed to delete stale VoIP token:', e.message));
              }
              console.error(`[RETRY] VoIP retry push failed (call=${callId}): ${pushResult.reason}`);
            }
          })
          .catch(err => console.error(`[RETRY] VoIP retry error:`, err.message));

      } else if (row.token_type === 'fcm') {
        admin.messaging().send({
          token: row.device_token,
          data: {
            type: 'incoming-call',
            callerName: 'Intercom',
            apartmentId: apartmentId || '',
            callId,
          },
          android: { priority: 'high', ttl: remainingSec * 1000 },
        })
          .then(() => {
            query(
              `UPDATE call_delivery_attempts SET delivery_state = 'push-sent', last_attempt_at = NOW()
               WHERE call_id = $1 AND device_token = $2 AND attempt_number = (
                 SELECT MAX(attempt_number) FROM call_delivery_attempts WHERE call_id = $1 AND device_token = $2
               )`,
              [callId, row.device_token]
            ).catch(e => console.error(`[RETRY] Error updating FCM retry attempt:`, e.message));
            upsertDeviceHealthSignal({
              deviceToken: row.device_token,
              tokenType: row.token_type,
              userId: row.user_id || null,
              apartmentId,
              platform: row.platform || 'android',
              lastSuccessfulPush: new Date(),
              lastPushFailure: null,
              lastPushError: null,
            }).catch(e => console.error(`[RETRY] Error upserting device health:`, e.message));
            console.log(`[RETRY] FCM retry push sent (call=${callId}, attempt=${newAttempt})`);
          })
          .catch(err => {
            query(
              `UPDATE call_delivery_attempts SET delivery_state = 'push-failed', last_error = $3, last_attempt_at = NOW()
               WHERE call_id = $1 AND device_token = $2 AND attempt_number = (
                 SELECT MAX(attempt_number) FROM call_delivery_attempts WHERE call_id = $1 AND device_token = $2
               )`,
              [callId, row.device_token, err.message]
            ).catch(e => console.error(`[RETRY] Error updating FCM retry attempt:`, e.message));
            upsertDeviceHealthSignal({
              deviceToken: row.device_token,
              tokenType: row.token_type,
              userId: row.user_id || null,
              apartmentId,
              platform: row.platform || 'android',
              lastPushFailure: new Date(),
              lastPushError: err.message || 'push-failed',
            }).catch(e => console.error(`[RETRY] Error upserting device health:`, e.message));
            if (err.code === 'messaging/registration-token-not-registered' || err.code === 'messaging/invalid-registration-token') {
              query("DELETE FROM device_tokens WHERE token = $1 AND token_type = 'fcm'", [row.device_token])
                .then(() => console.log('[RETRY] Deleted stale FCM token'))
                .catch((e) => console.error('[RETRY] Failed to delete stale FCM token:', e.message));
            }
            console.error(`[RETRY] FCM retry push failed (call=${callId}): ${err.message}`);
          });
      }
    }

    if (delaySec >= 8) {
      console.warn(`[RETRY] call=${callId} — ${result.rows.length} device(s) still unacked at t=${delaySec}s`);
    }
  } catch (err) {
    console.error(`[RETRY] Error during retry for call=${callId}:`, err.message);
  }
}

/**
 * Final check — if zero devices have acked, log delivery-degraded.
 */
async function checkDeliveryDegraded(callId) {
  try {
    // Check if call is still in 'calling' state
    const callResult = await query(
      `SELECT status, building_id, apartment_id, intercom_id FROM calls WHERE id = $1`,
      [callId]
    );
    if (callResult.rows.length === 0 || callResult.rows[0].status !== 'calling') return;

    const { building_id, apartment_id, intercom_id } = callResult.rows[0];

    // Check if ANY device has been acked (delivery_state beyond 'push-sent')
    const ackResult = await query(
      `SELECT COUNT(*) AS acked FROM call_delivery_attempts
       WHERE call_id = $1 AND delivery_state NOT IN ('queued', 'push-sent', 'push-failed', 'timed-out')`,
      [callId]
    );

    const ackedCount = parseInt(ackResult.rows[0].acked, 10);
    if (ackedCount === 0) {
      console.warn(`[RETRY] delivery-degraded: No device acked ring for call=${callId} after all retries`);
      query(
        `INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, call_id, description)
         VALUES ('delivery-degraded', $1, $2, $3, $4, $5)`,
        [building_id, apartment_id, intercom_id, callId,
         `No device acknowledged ring for call ${callId} after all retry attempts`]
      ).catch(e => console.error('[RETRY] Error inserting delivery-degraded audit log:', e.message));

      // Send ring-progress noResponse to intercom
      const intercom = getIntercom(intercom_id);
      if (intercom && intercom.ws.readyState === 1) {
        intercom.ws.send(JSON.stringify({
          type: 'ring-progress',
          callId,
          noResponse: true,
        }));
        console.log(`[RETRY] Sent ring-progress noResponse to intercom=${intercom_id}`);
      }
    }
  } catch (err) {
    console.error(`[RETRY] Error checking delivery-degraded for call=${callId}:`, err.message);
  }
}

module.exports = { startRetries, cancelRetries };
