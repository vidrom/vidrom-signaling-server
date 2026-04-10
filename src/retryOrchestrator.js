// Retry orchestrator — resends push notifications to devices that haven't acked
//
// After the initial ring at t=0, schedules retry checks at t=3s and t=8s.
// At t=15s performs a final check and logs delivery-degraded if zero acks.
// Retry intervals are capped to the building's no_answer_timeout.

const admin = require('firebase-admin');
const { query } = require('./db');
const { sendVoipPush, isAPNsReady } = require('./apnsService');
const { getIntercom } = require('./connectionState');

// callId → { timers: [timeout...], cancelled: boolean }
const retryState = new Map();

// Default retry schedule (seconds after ring start)
const RETRY_SCHEDULE = [3, 8];
const FINAL_CHECK_SEC = 15;

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
              console.log(`[RETRY] VoIP retry push sent (call=${callId}, attempt=${newAttempt})`);
            } else {
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
