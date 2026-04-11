// WebSocket connection handler — message routing and signaling logic
//
// Multi-tenant: supports multiple intercoms across buildings.
// Each intercom has its own active-call slot (keyed by deviceId).
// Home clients are resolved to their building's intercom via apartment → building lookup.
//
// - Intercom sends ring with apartmentId → all residents of that apartment are notified
// - First resident to accept gets the call; others receive 'call-taken'
// - WebRTC offer/answer/candidate flow between intercom ↔ accepted home client
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const { verifyToken } = require('./auth');
const { getDevice } = require('./devices');
const {
  clients, fcmTokens, voipTokens,
  addIntercom, removeIntercom, getIntercom, getIntercomForBuilding,
  addHomeClient, removeHomeClient, getHomeClients, sendToApartment,
  activeCall, activeCalls, setPendingRing, clearPendingRing, isPendingRing, getPendingRing,
  clearAcceptTimer,
} = require('./connectionState');
const { query } = require('./db');
const { sendVoipPush, isAPNsReady } = require('./apnsService');
const { startRetries, cancelRetries } = require('./retryOrchestrator');

// ---- Max-call-duration safety net (auto-hangup after 60s) ----
const MAX_CALL_DURATION_MS = 60_000;
const callDurationTimers = new Map(); // intercomDeviceId → timeout

function startCallDurationTimer(intercomDeviceId) {
  clearCallDurationTimer(intercomDeviceId);
  const timer = setTimeout(() => {
    callDurationTimers.delete(intercomDeviceId);
    const call = activeCall.get(intercomDeviceId);
    if (!call) return;
    console.log(`[TIMEOUT] Max call duration reached for intercom=${intercomDeviceId}, auto-hangup`);

    // Update DB: mark call as ended
    if (call.callId) {
      cancelRetries(call.callId);
      query("UPDATE calls SET status = 'ended', ended_at = NOW(), updated_at = NOW() WHERE id = $1", [call.callId]).catch(e => console.error('[DB] timeout update calls:', e.message));
      query("INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, call_id, description) VALUES ('call-ended', (SELECT building_id FROM calls WHERE id = $1), $2, $3, $1, 'Call ended by max duration timeout')", [call.callId, call.apartmentId, intercomDeviceId]).catch(e => console.error('[DB] timeout audit_log:', e.message));
    }

    // Notify both sides
    const intercom = getIntercom(intercomDeviceId);
    if (intercom && intercom.ws.readyState === 1) {
      intercom.ws.send(JSON.stringify({ type: 'hangup', reason: 'timeout', callId: call.callId }));
    }
    if (call.acceptedWs && call.acceptedWs.readyState === 1) {
      call.acceptedWs.send(JSON.stringify({ type: 'hangup', reason: 'timeout', callId: call.callId }));
    }
    sendToApartment(call.apartmentId, { type: 'hangup', reason: 'timeout', callId: call.callId });
    clearPendingRing(call.apartmentId);
    activeCall.clear(intercomDeviceId);
  }, MAX_CALL_DURATION_MS);
  callDurationTimers.set(intercomDeviceId, timer);
}

function clearCallDurationTimer(intercomDeviceId) {
  const timer = callDurationTimers.get(intercomDeviceId);
  if (timer) {
    clearTimeout(timer);
    callDurationTimers.delete(intercomDeviceId);
  }
}

function handleConnection(ws) {
  const id = uuidv4();
  let role = null;
  let deviceId = null;       // intercom deviceId (set on intercom register)
  let buildingId = null;      // resolved for both roles
  let apartmentId = null;     // set when home client registers with an apartment
  let intercomDeviceId = null; // which intercom this home client routes to

  // Mark alive for server-level heartbeat ping/pong
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  console.log(`[${id}] New connection`);

  ws.on('message', async (data) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch (err) {
      console.error(`[${id}] Invalid JSON:`, data.toString());
      return;
    }

    const { type } = message;
    console.log(`[${id}] Received: ${type}`);

    switch (type) {
      case 'register': {
        role = message.role; // "intercom" or "home"
        if (role !== 'intercom' && role !== 'home') {
          console.error(`[${id}] Invalid role: ${role}`);
          return;
        }

        // Intercom devices must authenticate with a JWT backed by persistent DB
        if (role === 'intercom') {
          if (!message.token) {
            console.error(`[${id}] Intercom rejected: no token provided`);
            ws.send(JSON.stringify({ type: 'error', message: 'Token required' }));
            ws.close();
            return;
          }
          try {
            const decoded = verifyToken(message.token);
            const device = await getDevice(decoded.deviceId);
            if (!device || device.status !== 'active') {
              console.error(`[${id}] Intercom rejected: device ${decoded.deviceId} not active`);
              ws.send(JSON.stringify({ type: 'error', message: 'Device revoked or not found' }));
              ws.close();
              return;
            }
            deviceId = decoded.deviceId;
            buildingId = decoded.buildingId;
            console.log(`[${id}] Intercom authenticated: device=${deviceId}, building=${buildingId}`);
            addIntercom(deviceId, buildingId, ws);
            // Legacy fallback
            clients.intercom = ws;
            await query("UPDATE intercoms SET status = 'connected' WHERE id = $1", [deviceId]);
          } catch (err) {
            console.error(`[${id}] Intercom rejected: invalid token — ${err.message}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
            ws.close();
            return;
          }
        }

        // Home clients register with their apartmentId
        if (role === 'home') {
          apartmentId = message.apartmentId || null;
          if (apartmentId) {
            // Resolve apartment → building → intercom
            try {
              const bldgResult = await query(
                'SELECT building_id FROM apartments WHERE id = $1', [apartmentId]
              );
              if (bldgResult.rows[0]) {
                buildingId = bldgResult.rows[0].building_id;
                const intercom = getIntercomForBuilding(buildingId);
                if (intercom) {
                  intercomDeviceId = intercom.deviceId;
                }
              }
            } catch (err) {
              console.error(`[${id}] Failed to resolve building for apartment=${apartmentId}:`, err.message);
            }
            addHomeClient(apartmentId, id, ws, buildingId);
            console.log(`[${id}] Home registered for apartment=${apartmentId}, building=${buildingId}, intercom=${intercomDeviceId || 'none'}`);
          } else {
            // Legacy: no apartmentId — treat as single home client
            clients.home = ws;
            console.log(`[${id}] Home registered (legacy, no apartmentId)`);
          }
        }

        console.log(`[${id}] Registered as "${role}"`);
        ws.send(JSON.stringify({ type: 'registered', role }));

        // Late-join: if home just connected and there's an active ring or accepted call, notify them
        if (role === 'home' && apartmentId) {
          const pendingCallInfo = activeCall.getByApartment(apartmentId);
          if (isPendingRing(apartmentId) && pendingCallInfo) {
            console.log(`[${id}] Late-join: re-sending pending ring to home (apartment=${apartmentId}, lateJoin=true)`);
            ws.send(JSON.stringify({ type: 'ring', callId: pendingCallInfo.callId || null, buildingId, apartmentId, lateJoin: true }));
            query(
              "INSERT INTO audit_logs (event_type, building_id, apartment_id, call_id, description) VALUES ('late-join-ring', $1, $2, $3, 'Device late-joined active ringing call')",
              [buildingId, apartmentId, pendingCallInfo.callId || null]
            ).catch(e => console.error('[DB] late-join audit_log:', e.message));
          } else if (pendingCallInfo && pendingCallInfo.acceptedBy) {
            // Call already accepted by another device
            console.log(`[${id}] Late-join: call already accepted callId=${pendingCallInfo.callId} — sending call-taken (apartment=${apartmentId})`);
            ws.send(JSON.stringify({ type: 'call-taken', callId: pendingCallInfo.callId || null }));
            query(
              "INSERT INTO audit_logs (event_type, building_id, apartment_id, call_id, description) VALUES ('late-join-call-taken', $1, $2, $3, 'Device late-joined but call already accepted')",
              [buildingId, apartmentId, pendingCallInfo.callId || null]
            ).catch(e => console.error('[DB] late-join-call-taken audit_log:', e.message));
          }
        }
        break;
      }

      case 'ring': {
        // Intercom rings a specific apartment
        const targetApartmentId = message.apartmentId;
        if (!targetApartmentId) {
          console.error(`[${id}] Ring without apartmentId`);
          break;
        }
        if (!deviceId) {
          console.error(`[${id}] Ring from non-intercom connection`);
          break;
        }

        console.log(`[${id}] Ring for apartment=${targetApartmentId} from intercom=${deviceId}`);

        // ---- Sleep mode check ----
        let sleepingUserIds = new Set();
        let allResidentsSleeping = false;
        try {
          const sleepResult = await query(
            'SELECT u.id, u.sleep_mode FROM users u JOIN apartment_residents ar ON ar.user_id = u.id WHERE ar.apartment_id = $1',
            [targetApartmentId]
          );
          if (sleepResult.rows.length > 0) {
            for (const row of sleepResult.rows) {
              if (row.sleep_mode) sleepingUserIds.add(row.id);
            }
            allResidentsSleeping = sleepingUserIds.size === sleepResult.rows.length;
          }
        } catch (err) {
          console.error(`[${id}] Error querying sleep mode:`, err.message);
        }

        if (allResidentsSleeping) {
          console.log(`[${id}] All residents sleeping for apartment=${targetApartmentId}, skipping ring`);
          ws.send(JSON.stringify({ type: 'apartment-unavailable', reason: 'all-residents-sleeping', apartmentId: targetApartmentId }));
          query(
            "INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, description) VALUES ('ring-skipped-sleep-mode', $1, $2, $3, 'Ring skipped — all residents have sleep mode enabled')",
            [buildingId, targetApartmentId, deviceId]
          ).catch(e => console.error('[DB] sleep-mode audit_log:', e.message));
          break;
        }

        if (sleepingUserIds.size > 0) {
          console.log(`[${id}] ${sleepingUserIds.size} resident(s) sleeping — will filter push tokens`);
          query(
            "INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, description) VALUES ('ring-skipped-sleep-mode', $1, $2, $3, $4)",
            [buildingId, targetApartmentId, deviceId, `Ring delivery filtered — ${sleepingUserIds.size} resident(s) in sleep mode`]
          ).catch(e => console.error('[DB] sleep-mode partial audit_log:', e.message));
        }

        // If a watch session is active on this intercom, end it first — calls take priority
        const prevCall = activeCall.get(deviceId);
        if (prevCall && prevCall.type === 'watch') {
          if (prevCall.acceptedWs && prevCall.acceptedWs.readyState === 1) {
            prevCall.acceptedWs.send(JSON.stringify({ type: 'watch-end' }));
            console.log(`[${id}] Ended active watch session for incoming ring`);
          }
          activeCall.clear(deviceId);
        }

        // Create call record in DB and start tracking
        const callId = uuidv4();
        try {
          await query(
            "INSERT INTO calls (id, building_id, apartment_id, intercom_id, status, expires_at) VALUES ($1, $2, $3, $4, 'calling', NOW() + make_interval(secs => $5))",
            [callId, buildingId, targetApartmentId, deviceId, ringTimeoutSec]
          );
          await query(
            "INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, call_id, description) VALUES ('call-initiated', $1, $2, $3, $4, 'Ring started by intercom')",
            [buildingId, targetApartmentId, deviceId, callId]
          );
        } catch (err) {
          console.error(`[${id}] Error inserting call record:`, err.message);
        }

        activeCall.start(deviceId, targetApartmentId, 'call', callId);

        // Query building-level no_answer_timeout for this apartment
        let ringTimeoutSec = 30;
        try {
          const bldgResult = await query(
            'SELECT b.no_answer_timeout FROM buildings b JOIN apartments a ON a.building_id = b.id WHERE a.id = $1',
            [targetApartmentId]
          );
          if (bldgResult.rows.length > 0 && bldgResult.rows[0].no_answer_timeout != null) {
            ringTimeoutSec = bldgResult.rows[0].no_answer_timeout;
          } else {
            const gsResult = await query(
              "SELECT value FROM global_settings WHERE key = 'no_answer_timeout'"
            );
            if (gsResult.rows.length > 0) {
              ringTimeoutSec = parseInt(gsResult.rows[0].value, 10) || 30;
            }
          }
        } catch (err) {
          console.error(`[${id}] Error querying no_answer_timeout, using default 30s:`, err.message);
        }
        const ringTimeoutMs = ringTimeoutSec * 1000;
        console.log(`[${id}] Ring timeout for apartment=${targetApartmentId}: ${ringTimeoutSec}s`);

        setPendingRing(targetApartmentId, deviceId, ringTimeoutMs, (expiredCall) => {
          // Ring expired — cancel retries and update DB
          if (expiredCall.callId) {
            cancelRetries(expiredCall.callId);
            query("UPDATE calls SET status = 'unanswered', updated_at = NOW() WHERE id = $1", [expiredCall.callId]).catch(e => console.error('[DB] ring-expired update calls:', e.message));
            query("INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, call_id, description) VALUES ('call-unanswered', $1, $2, $3, $4, 'Ring expired with no answer')", [buildingId, targetApartmentId, deviceId, expiredCall.callId]).catch(e => console.error('[DB] ring-expired audit_log:', e.message));
          }
        });

        // 1. Send WS ring to all connected home clients for this apartment
        const wsSent = sendToApartment(targetApartmentId, { type: 'ring', callId });
        console.log(`[${id}] Ring sent to ${wsSent} connected home client(s)`);

        // 2. Send push notifications to all registered devices for this apartment (from DB)
        //    Filter out sleeping users if any
        try {
          let tokenResult;
          if (sleepingUserIds.size > 0) {
            const awakeParams = [targetApartmentId, ...sleepingUserIds];
            const placeholders = [...sleepingUserIds].map((_, i) => `$${i + 2}`).join(', ');
            tokenResult = await query(
              `SELECT token, token_type, platform, user_id FROM device_tokens WHERE apartment_id = $1 AND user_id NOT IN (${placeholders})`,
              awakeParams
            );
          } else {
            tokenResult = await query(
              'SELECT token, token_type, platform, user_id FROM device_tokens WHERE apartment_id = $1',
              [targetApartmentId]
            );
          }

          // Insert delivery attempt rows for each device
          for (const row of tokenResult.rows) {
            query(
              `INSERT INTO call_delivery_attempts (call_id, user_id, device_token, token_type, platform, delivery_state)
               VALUES ($1, $2, $3, $4, $5, 'queued')`,
              [callId, row.user_id || null, row.token, row.token_type, row.platform || (row.token_type === 'voip' ? 'ios' : 'android')]
            ).catch(e => console.error(`[${id}] Error inserting delivery attempt:`, e.message));
          }

          for (const row of tokenResult.rows) {
            if (row.token_type === 'voip' && isAPNsReady()) {
              // iOS VoIP push
              sendVoipPush(row.token, 'Intercom', { callerName: 'Intercom', type: 'incoming-call', callId }, ringTimeoutSec)
                .then((result) => {
                  if (result.success) {
                    console.log(`[${id}] VoIP push sent (apartment=${targetApartmentId})`);
                    query(
                      `UPDATE call_delivery_attempts SET delivery_state = 'push-sent', last_attempt_at = NOW()
                       WHERE call_id = $1 AND device_token = $2 AND attempt_number = (
                         SELECT MAX(attempt_number) FROM call_delivery_attempts WHERE call_id = $1 AND device_token = $2
                       )`, [callId, row.token]
                    ).catch(e => console.error(`[${id}] Error updating delivery attempt:`, e.message));
                  } else {
                    console.error(`[${id}] VoIP push failed: ${result.reason}`);
                    query(
                      `UPDATE call_delivery_attempts SET delivery_state = 'push-failed', last_error = $3, last_attempt_at = NOW()
                       WHERE call_id = $1 AND device_token = $2 AND attempt_number = (
                         SELECT MAX(attempt_number) FROM call_delivery_attempts WHERE call_id = $1 AND device_token = $2
                       )`, [callId, row.token, result.reason]
                    ).catch(e => console.error(`[${id}] Error updating delivery attempt:`, e.message));
                    if (result.reason === 'BadDeviceToken' || result.reason === 'Unregistered') {
                      query("DELETE FROM device_tokens WHERE token = $1 AND token_type = 'voip'", [row.token])
                        .then(() => console.log(`[${id}] Deleted stale VoIP token`))
                        .catch((e) => console.error(`[${id}] Failed to delete stale VoIP token:`, e.message));
                    }
                  }
                })
                .catch((err) => console.error(`[${id}] VoIP push error:`, err.message));
            } else if (row.token_type === 'fcm') {
              // FCM push (Android or iOS fallback)
              admin.messaging().send({
                token: row.token,
                data: {
                  type: 'incoming-call',
                  callerName: 'Intercom',
                  apartmentId: targetApartmentId,
                  callId,
                },
                android: { priority: 'high', ttl: ringTimeoutMs },
              })
                .then(() => {
                  console.log(`[${id}] FCM push sent (apartment=${targetApartmentId}, platform=${row.platform})`);
                  query(
                    `UPDATE call_delivery_attempts SET delivery_state = 'push-sent', last_attempt_at = NOW()
                     WHERE call_id = $1 AND device_token = $2 AND attempt_number = (
                       SELECT MAX(attempt_number) FROM call_delivery_attempts WHERE call_id = $1 AND device_token = $2
                     )`, [callId, row.token]
                  ).catch(e => console.error(`[${id}] Error updating delivery attempt:`, e.message));
                })
                .catch((err) => {
                  console.error(`[${id}] FCM push failed:`, err.message);
                  query(
                    `UPDATE call_delivery_attempts SET delivery_state = 'push-failed', last_error = $3, last_attempt_at = NOW()
                     WHERE call_id = $1 AND device_token = $2 AND attempt_number = (
                       SELECT MAX(attempt_number) FROM call_delivery_attempts WHERE call_id = $1 AND device_token = $2
                     )`, [callId, row.token, err.message]
                  ).catch(e => console.error(`[${id}] Error updating delivery attempt:`, e.message));
                  if (err.code === 'messaging/registration-token-not-registered' || err.code === 'messaging/invalid-registration-token') {
                    query("DELETE FROM device_tokens WHERE token = $1 AND token_type = 'fcm'", [row.token])
                      .then(() => console.log(`[${id}] Deleted stale FCM token`))
                      .catch((e) => console.error(`[${id}] Failed to delete stale FCM token:`, e.message));
                  }
                });
            }
          }

          if (tokenResult.rows.length === 0) {
            console.log(`[${id}] No push tokens found for apartment=${targetApartmentId}`);
          } else {
            // Start retry orchestration for unacked devices
            startRetries(callId, ringTimeoutSec);

            // Send ring-progress to intercom: how many devices were notified
            ws.send(JSON.stringify({
              type: 'ring-progress',
              callId,
              devicesNotified: tokenResult.rows.length,
            }));
          }
        } catch (err) {
          console.error(`[${id}] Error querying device tokens:`, err.message);
        }

        // Legacy in-memory tokens and WS client are no longer used for ring routing.
        // All notifications now go through the per-apartment device_tokens DB table above.

        break;
      }

      case 'accept': {
        // Home accepts the call — first-accept-wins
        // Resolve which intercom's call this home client is accepting
        const targetIntercom = intercomDeviceId || (apartmentId ? (activeCall.getByApartment(apartmentId) || {}).intercomDeviceId : null);
        const call = targetIntercom ? activeCall.get(targetIntercom) : null;
        if (!call) {
          ws.send(JSON.stringify({ type: 'error', message: 'No active call' }));
          break;
        }

        // Check if this call was already HTTP-accepted by this same user
        const wsUserId = message.userId || null;
        const httpAlreadyAccepted = call.httpAcceptedBy && wsUserId && call.httpAcceptedBy === wsUserId;

        if (httpAlreadyAccepted) {
          // Same device that HTTP-accepted — upgrade the in-memory state with WS refs
          intercomDeviceId = targetIntercom;
          call.acceptedBy = id;
          call.acceptedWs = ws;
          startCallDurationTimer(targetIntercom);
          // Cancel accept reservation timer — device connected successfully
          if (call.callId) clearAcceptTimer(call.callId);
          console.log(`[${id}] WS accept reconciled with prior HTTP accept (user=${wsUserId})`);
          break;
        }

        const accepted = activeCall.accept(targetIntercom, id, ws);
        if (accepted) {
          // Update this home client's intercom target
          intercomDeviceId = targetIntercom;
          // This resident won the race — relay accept to intercom
          clearPendingRing(call.apartmentId);
          startCallDurationTimer(targetIntercom);
          if (call.callId) cancelRetries(call.callId);

          // Update DB: call accepted
          if (call.callId) {
            query("UPDATE calls SET status = 'accepted', updated_at = NOW() WHERE id = $1", [call.callId]).catch(e => console.error('[DB] accept update calls:', e.message));
            query("INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, call_id, description) VALUES ('call-accepted', (SELECT building_id FROM calls WHERE id = $1), $2, $3, $1, 'Call accepted by resident')", [call.callId, call.apartmentId, targetIntercom]).catch(e => console.error('[DB] accept audit_log:', e.message));
          }

          const intercom = getIntercom(targetIntercom);
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'accept', callId: call.callId }));
            console.log(`[${id}] Accept relayed to intercom=${targetIntercom} (first-accept-wins)`);
          }

          // Notify ALL OTHER home clients for this apartment that the call was taken
          const aptClients = getHomeClients(call.apartmentId);
          for (const [connId, entry] of aptClients) {
            if (connId !== id && entry.ws.readyState === 1) {
              entry.ws.send(JSON.stringify({ type: 'call-taken', callId: call.callId }));
              console.log(`[${id}] Sent call-taken to ${connId}`);
            }
          }
          // Also notify legacy home client if it's not the acceptor
          if (clients.home && clients.home !== ws && clients.home.readyState === 1) {
            clients.home.send(JSON.stringify({ type: 'call-taken', callId: call.callId }));
          }

          // Send call-taken push to devices that may not have a WS connection
          try {
            const callTakenTokens = await query(
              'SELECT token, token_type FROM device_tokens WHERE apartment_id = $1',
              [call.apartmentId]
            );
            for (const row of callTakenTokens.rows) {
              if (row.token_type === 'voip' && isAPNsReady()) {
                // iOS: VoIP push is the only reliable way to wake the app and dismiss CallKit
                sendVoipPush(row.token, 'call-taken', { type: 'call-taken', callId: call.callId })
                  .then((result) => {
                    if (result.success) {
                      console.log(`[${id}] call-taken VoIP push sent (apartment=${call.apartmentId})`);
                    } else {
                      console.error(`[${id}] call-taken VoIP push failed: ${result.reason}`);
                      if (result.reason === 'BadDeviceToken' || result.reason === 'Unregistered') {
                        query("DELETE FROM device_tokens WHERE token = $1 AND token_type = 'voip'", [row.token])
                          .then(() => console.log(`[${id}] Deleted stale VoIP token (call-taken)`))
                          .catch((e) => console.error(`[${id}] Failed to delete stale VoIP token:`, e.message));
                      }
                    }
                  })
                  .catch((err) => console.error(`[${id}] call-taken VoIP push error:`, err.message));
              } else if (row.token_type === 'fcm') {
                admin.messaging().send({
                  token: row.token,
                  data: { type: 'call-taken', callId: call.callId || '' },
                  android: { priority: 'high' },
                })
                  .then(() => console.log(`[${id}] call-taken FCM sent (apartment=${call.apartmentId})`))
                  .catch((err) => {
                    console.error(`[${id}] call-taken FCM failed:`, err.message);
                    if (err.code === 'messaging/registration-token-not-registered' || err.code === 'messaging/invalid-registration-token') {
                      query("DELETE FROM device_tokens WHERE token = $1 AND token_type = 'fcm'", [row.token])
                        .then(() => console.log(`[${id}] Deleted stale FCM token (call-taken)`))
                        .catch((e) => console.error(`[${id}] Failed to delete stale FCM token:`, e.message));
                    }
                  });
              }
            }
          } catch (err) {
            console.error(`[${id}] Error sending call-taken push:`, err.message);
          }
        } else {
          // Someone else already accepted — tell this client
          ws.send(JSON.stringify({ type: 'call-taken', callId: call.callId }));
          console.log(`[${id}] Call already accepted, sent call-taken`);
        }
        break;
      }

      case 'decline': {
        // Individual resident declines — doesn't end the call for others
        const targetIntercom = intercomDeviceId || (apartmentId ? (activeCall.getByApartment(apartmentId) || {}).intercomDeviceId : null);
        const call = targetIntercom ? activeCall.get(targetIntercom) : null;
        if (!call) break;

        activeCall.decline(targetIntercom, id);
        console.log(`[${id}] Declined call (apartment=${call.apartmentId}, intercom=${targetIntercom})`);

        // Check if ALL connected home clients for this apartment have declined
        const aptClients = getHomeClients(call.apartmentId);
        let allDeclined = true;
        for (const [connId] of aptClients) {
          if (!call.declinedBy.has(connId)) {
            allDeclined = false;
            break;
          }
        }

        if (allDeclined && aptClients.size > 0) {
          // Everyone declined — relay to intercom
          clearPendingRing(call.apartmentId);
          clearCallDurationTimer(targetIntercom);
          if (call.callId) cancelRetries(call.callId);

          // Update DB: all rejected
          if (call.callId) {
            query("UPDATE calls SET status = 'rejected', updated_at = NOW() WHERE id = $1", [call.callId]).catch(e => console.error('[DB] decline update calls:', e.message));
            query("INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, call_id, description) VALUES ('call-rejected', (SELECT building_id FROM calls WHERE id = $1), $2, $3, $1, 'All residents declined')", [call.callId, call.apartmentId, targetIntercom]).catch(e => console.error('[DB] decline audit_log:', e.message));
          }

          activeCall.clear(targetIntercom);
          const intercom = getIntercom(targetIntercom);
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'decline' }));
            console.log(`[${id}] All residents declined — relayed to intercom=${targetIntercom}`);
          }
        }
        break;
      }

      case 'offer': {
        // WebRTC SDP offer — route based on role
        if (role === 'home') {
          // Cancel accept reservation timer — device is connected and sending offer
          const offerCall = intercomDeviceId ? activeCall.get(intercomDeviceId)
            : (apartmentId ? activeCall.getByApartment(apartmentId) : null);
          if (offerCall && offerCall.callId) clearAcceptTimer(offerCall.callId);

          // Home → Intercom (route to the correct intercom for this building)
          const intercom = intercomDeviceId ? getIntercom(intercomDeviceId) : null;
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'offer', sdp: message.sdp }));
            console.log(`[${id}] Offer relayed to intercom=${intercomDeviceId}`);
          } else if (clients.intercom && clients.intercom.readyState === 1) {
            // Legacy fallback
            clients.intercom.send(JSON.stringify({ type: 'offer', sdp: message.sdp }));
            console.log(`[${id}] Offer relayed to intercom (legacy)`);
          }
        } else if (role === 'intercom') {
          // Intercom → accepted home client
          const call = activeCall.get(deviceId);
          if (call && call.acceptedWs && call.acceptedWs.readyState === 1) {
            call.acceptedWs.send(JSON.stringify({ type: 'offer', sdp: message.sdp }));
            console.log(`[${id}] Offer relayed to accepted home`);
          } else if (clients.home && clients.home.readyState === 1) {
            // Legacy fallback
            clients.home.send(JSON.stringify({ type: 'offer', sdp: message.sdp }));
            console.log(`[${id}] Offer relayed to home (legacy)`);
          }
        }
        break;
      }

      case 'answer': {
        // WebRTC SDP answer — route based on role
        if (role === 'home') {
          // Home → Intercom
          const intercom = intercomDeviceId ? getIntercom(intercomDeviceId) : null;
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'answer', sdp: message.sdp }));
            console.log(`[${id}] Answer relayed to intercom=${intercomDeviceId}`);
          } else if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'answer', sdp: message.sdp }));
            console.log(`[${id}] Answer relayed to intercom (legacy)`);
          }
        } else if (role === 'intercom') {
          // Intercom → accepted home client
          const call = activeCall.get(deviceId);
          if (call && call.acceptedWs && call.acceptedWs.readyState === 1) {
            call.acceptedWs.send(JSON.stringify({ type: 'answer', sdp: message.sdp }));
            console.log(`[${id}] Answer relayed to accepted home`);
          } else if (clients.home && clients.home.readyState === 1) {
            clients.home.send(JSON.stringify({ type: 'answer', sdp: message.sdp }));
            console.log(`[${id}] Answer relayed to home (legacy)`);
          }
        }
        break;
      }

      case 'candidate': {
        // ICE candidate exchange (bidirectional)
        if (role === 'intercom') {
          // Intercom → accepted home client
          const call = activeCall.get(deviceId);
          if (call && call.acceptedWs && call.acceptedWs.readyState === 1) {
            call.acceptedWs.send(JSON.stringify({ type: 'candidate', candidate: message.candidate }));
          } else if (clients.home && clients.home.readyState === 1) {
            clients.home.send(JSON.stringify({ type: 'candidate', candidate: message.candidate }));
          }
        } else {
          // Home → Intercom
          const intercom = intercomDeviceId ? getIntercom(intercomDeviceId) : null;
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'candidate', candidate: message.candidate }));
          } else if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'candidate', candidate: message.candidate }));
          }
        }
        console.log(`[${id}] ICE candidate relayed`);
        break;
      }

      case 'open-door': {
        // Home tells intercom to open the door
        const intercom = intercomDeviceId ? getIntercom(intercomDeviceId) : null;
        if (intercom && intercom.ws.readyState === 1) {
          intercom.ws.send(JSON.stringify({ type: 'open-door' }));
          console.log(`[${id}] Open-door relayed to intercom=${intercomDeviceId}`);
        } else if (clients.intercom && clients.intercom.readyState === 1) {
          clients.intercom.send(JSON.stringify({ type: 'open-door' }));
          console.log(`[${id}] Open-door relayed to intercom (legacy)`);
        }
        // Clear the active call
        const targetIntercom = intercomDeviceId || deviceId;
        if (targetIntercom) {
          const call = activeCall.get(targetIntercom);
          if (call) {
            // Update DB: call ended (door opened)
            if (call.callId) {
              cancelRetries(call.callId);
              query("UPDATE calls SET status = 'ended', ended_at = NOW(), updated_at = NOW() WHERE id = $1", [call.callId]).catch(e => console.error('[DB] open-door update calls:', e.message));
              query("INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, call_id, description) VALUES ('call-ended', (SELECT building_id FROM calls WHERE id = $1), $2, $3, $1, 'Call ended after door open')", [call.callId, call.apartmentId, targetIntercom]).catch(e => console.error('[DB] open-door audit_log:', e.message));
            }
            clearPendingRing(call.apartmentId);
            clearCallDurationTimer(targetIntercom);
            activeCall.clear(targetIntercom);
          }
        }
        console.log(`[${id}] Hangup relayed (after open-door)`);
        break;
      }

      case 'hangup': {
        // Either side hangs up
        if (role === 'intercom') {
          const call = activeCall.get(deviceId);
          if (call) {
            clearPendingRing(call.apartmentId);
            clearCallDurationTimer(deviceId);
            if (call.callId) cancelRetries(call.callId);

            // Update DB: call ended
            if (call.callId) {
              query("UPDATE calls SET status = 'ended', ended_at = NOW(), updated_at = NOW() WHERE id = $1", [call.callId]).catch(e => console.error('[DB] hangup update calls:', e.message));
              query("INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, call_id, description) VALUES ('call-ended', (SELECT building_id FROM calls WHERE id = $1), $2, $3, $1, 'Call ended by intercom hangup')", [call.callId, call.apartmentId, deviceId]).catch(e => console.error('[DB] hangup audit_log:', e.message));
            }

            // Notify the accepted home client + all ringing clients
            if (call.acceptedWs && call.acceptedWs.readyState === 1) {
              call.acceptedWs.send(JSON.stringify({ type: 'hangup', callId: call.callId }));
            }
            sendToApartment(call.apartmentId, { type: 'hangup', callId: call.callId });
            activeCall.clear(deviceId);
          }
          // Legacy fallback
          if (clients.home && clients.home.readyState === 1) {
            clients.home.send(JSON.stringify({ type: 'hangup' }));
          }
        } else {
          // Home hung up — notify the correct intercom
          const targetIntercom = intercomDeviceId || (apartmentId ? (activeCall.getByApartment(apartmentId) || {}).intercomDeviceId : null);
          if (targetIntercom) {
            const call = activeCall.get(targetIntercom);
            if (call) {
              // Only relay hangup if this is the accepted client (or no one accepted yet).
              // Other apartment devices that lost the first-accept-wins race may
              // spuriously send hangup when their CallKit UI is dismissed; relaying
              // that would kill the winning device's call.
              if (call.acceptedBy && call.acceptedBy !== id) {
                console.log(`[${id}] Hangup ignored — not the accepted client (accepted=${call.acceptedBy})`);
                break;
              }

              // Update DB: call ended
              if (call.callId) {
                cancelRetries(call.callId);
                query("UPDATE calls SET status = 'ended', ended_at = NOW(), updated_at = NOW() WHERE id = $1", [call.callId]).catch(e => console.error('[DB] hangup update calls:', e.message));
                query("INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, call_id, description) VALUES ('call-ended', (SELECT building_id FROM calls WHERE id = $1), $2, $3, $1, 'Call ended by home hangup')", [call.callId, call.apartmentId, targetIntercom]).catch(e => console.error('[DB] hangup audit_log:', e.message));
              }

              clearPendingRing(call.apartmentId);
              clearCallDurationTimer(targetIntercom);
              activeCall.clear(targetIntercom);
            }
            const intercom = getIntercom(targetIntercom);
            if (intercom && intercom.ws.readyState === 1) {
              intercom.ws.send(JSON.stringify({ type: 'hangup' }));
              console.log(`[${id}] Hangup relayed to intercom=${targetIntercom}`);
            }
          } else if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'hangup' }));
            console.log(`[${id}] Hangup relayed to intercom (legacy)`);
          }
        }
        break;
      }

      case 'watch': {
        // Home wants to view intercom camera — route to their building's intercom
        const intercom = intercomDeviceId ? getIntercom(intercomDeviceId) : null;
        const targetWs = intercom ? intercom.ws : clients.intercom;
        const targetDeviceId = intercomDeviceId || deviceId;

        if (targetWs && targetWs.readyState === 1) {
          const call = targetDeviceId ? activeCall.get(targetDeviceId) : null;

          // Don't allow watch during an active call
          if (call && call.type === 'call') {
            ws.send(JSON.stringify({ type: 'error', message: 'Intercom is busy on a call' }));
            console.log(`[${id}] Watch rejected — active call in progress on intercom=${targetDeviceId}`);
            break;
          }

          // If someone else is already watching this intercom, end their session
          if (call && call.type === 'watch' && call.acceptedWs && call.acceptedWs.readyState === 1) {
            call.acceptedWs.send(JSON.stringify({ type: 'watch-end' }));
            console.log(`[${id}] Displaced previous watcher on intercom=${targetDeviceId}`);
            targetWs.send(JSON.stringify({ type: 'watch-end' }));
          }

          // Track this as a watch so offer/answer/candidate routes correctly
          if (targetDeviceId && apartmentId) {
            activeCall.start(targetDeviceId, apartmentId, 'watch');
            activeCall.accept(targetDeviceId, id, ws);
          }
          targetWs.send(JSON.stringify({ type: 'watch' }));
          console.log(`[${id}] Watch request relayed to intercom=${targetDeviceId}`);
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Intercom not connected' }));
        }
        break;
      }

      case 'watch-end': {
        const targetIntercom = role === 'intercom' ? deviceId
          : (intercomDeviceId || (apartmentId ? (activeCall.getByApartment(apartmentId) || {}).intercomDeviceId : null));
        const call = targetIntercom ? activeCall.get(targetIntercom) : null;

        // Only clear if this is a watch session (don't accidentally clear an active call)
        if (call && call.type === 'watch') activeCall.clear(targetIntercom);

        if (role === 'home') {
          const intercom = targetIntercom ? getIntercom(targetIntercom) : null;
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'watch-end' }));
            console.log(`[${id}] Watch-end relayed to intercom=${targetIntercom}`);
          } else if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'watch-end' }));
            console.log(`[${id}] Watch-end relayed to intercom (legacy)`);
          }
        } else {
          if (call && call.acceptedWs && call.acceptedWs.readyState === 1) {
            call.acceptedWs.send(JSON.stringify({ type: 'watch-end' }));
          } else if (clients.home && clients.home.readyState === 1) {
            clients.home.send(JSON.stringify({ type: 'watch-end' }));
          }
        }
        break;
      }

      case 'register-fcm-token': {
        // WS-based FCM token registration
        if (apartmentId && message.userId) {
          const platform = message.platform || 'android';
          await query(
            `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, updated_at)
             VALUES ($1, $2, $3, 'fcm', $4, NOW())
             ON CONFLICT (token, token_type) DO UPDATE SET apartment_id = $1, user_id = $2, platform = $4, updated_at = NOW()`,
            [apartmentId, message.userId, message.token, platform]
          );
          await query(
            "DELETE FROM device_tokens WHERE user_id = $1 AND token_type = 'fcm' AND token != $2",
            [message.userId, message.token]
          );
          console.log(`[${id}] FCM token registered via WS (apartment=${apartmentId})`);
        } else if (role) {
          // Legacy fallback
          fcmTokens.set(role, message.token);
          console.log(`[${id}] FCM token registered for "${role}" (legacy)`);
        }
        break;
      }

      default:
        console.log(`[${id}] Unknown message type: ${type}`);
    }
  });

  ws.on('close', () => {
    console.log(`[${id}] Disconnected (role: ${role})`);

    if (role === 'intercom') {
      if (deviceId) {
        // Notify home clients for any active call on this intercom
        const call = activeCall.get(deviceId);
        if (call) {
          clearPendingRing(call.apartmentId);
          clearCallDurationTimer(deviceId);

          // Update DB: call ended due to intercom disconnect
          if (call.callId) {
            cancelRetries(call.callId);
            query("UPDATE calls SET status = 'ended', ended_at = NOW(), updated_at = NOW() WHERE id = $1", [call.callId]).catch(e => console.error('[DB] intercom-disconnect update calls:', e.message));
            query("INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, call_id, description) VALUES ('call-ended', (SELECT building_id FROM calls WHERE id = $1), $2, $3, $1, 'Call ended by intercom disconnect')", [call.callId, call.apartmentId, deviceId]).catch(e => console.error('[DB] intercom-disconnect audit_log:', e.message));
          }

          sendToApartment(call.apartmentId, { type: 'peer-disconnected', role: 'intercom' });
          activeCall.clear(deviceId);
        }
        removeIntercom(deviceId);
        query("UPDATE intercoms SET status = 'disconnected' WHERE id = $1", [deviceId])
          .catch(err => console.error(`[${id}] Failed to update intercom status:`, err.message));
      }
      // Legacy fallback
      if (clients.intercom === ws) clients.intercom = null;
      if (clients.home && clients.home.readyState === 1) {
        clients.home.send(JSON.stringify({ type: 'peer-disconnected', role: 'intercom' }));
      }
    }

    if (role === 'home') {
      if (apartmentId) {
        removeHomeClient(apartmentId, id);
      }
      if (clients.home === ws) {
        clients.home = null;
      }
      // Find if this home client was part of an active call
      const targetIntercom = intercomDeviceId || (apartmentId ? (activeCall.getByApartment(apartmentId) || {}).intercomDeviceId : null);
      const call = targetIntercom ? activeCall.get(targetIntercom) : null;

      if (call && call.acceptedBy === id) {
        // Accepted client disconnected — notify intercom
        clearCallDurationTimer(targetIntercom);

        // Update DB: call ended due to home disconnect
        if (call.callId) {
          query("UPDATE calls SET status = 'ended', ended_at = NOW(), updated_at = NOW() WHERE id = $1", [call.callId]).catch(e => console.error('[DB] home-disconnect update calls:', e.message));
          query("INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, call_id, description) VALUES ('call-ended', (SELECT building_id FROM calls WHERE id = $1), $2, $3, $1, 'Call ended by home disconnect')", [call.callId, call.apartmentId, targetIntercom]).catch(e => console.error('[DB] home-disconnect audit_log:', e.message));
        }

        activeCall.clear(targetIntercom);
        const intercom = getIntercom(targetIntercom);
        if (intercom && intercom.ws.readyState === 1) {
          intercom.ws.send(JSON.stringify({ type: 'peer-disconnected', role: 'home' }));
        }
      } else if (call && call.apartmentId === apartmentId && !call.acceptedBy) {
        // Ringing client disconnected — treat as implicit decline
        activeCall.decline(targetIntercom, id);
        const aptClients = getHomeClients(call.apartmentId);
        let allDeclined = true;
        for (const [connId] of aptClients) {
          if (!call.declinedBy.has(connId)) {
            allDeclined = false;
            break;
          }
        }
        if (allDeclined) {
          clearPendingRing(call.apartmentId);
          clearCallDurationTimer(targetIntercom);

          // Update DB: all rejected (via disconnect)
          if (call.callId) {
            query("UPDATE calls SET status = 'rejected', updated_at = NOW() WHERE id = $1", [call.callId]).catch(e => console.error('[DB] disconnect-decline update calls:', e.message));
            query("INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, call_id, description) VALUES ('call-rejected', (SELECT building_id FROM calls WHERE id = $1), $2, $3, $1, 'All residents declined/disconnected')", [call.callId, call.apartmentId, targetIntercom]).catch(e => console.error('[DB] disconnect-decline audit_log:', e.message));
          }

          activeCall.clear(targetIntercom);
          const intercom = getIntercom(targetIntercom);
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'decline' }));
            console.log(`[${id}] All residents declined/disconnected — relayed to intercom=${targetIntercom}`);
          }
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[${id}] Error:`, err.message);
  });
}

module.exports = { handleConnection };
