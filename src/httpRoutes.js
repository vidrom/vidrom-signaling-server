// HTTP route handler — EC2-resident endpoints only
// Portal APIs (/api/admin/*, /api/management/*) have moved to Lambda (see ../lambda/)
// Portal HTML (admin.html, management.html) served from S3+CloudFront (see ../portals/)
const { generateDeviceToken, verifyToken } = require('./auth');
const { clients, fcmTokens, voipTokens, activeCall, activeCalls, intercoms, getIntercom, getIntercomForBuilding, getHomeClients, clearPendingRing, isPendingRing, sendToApartment, startAcceptTimer, clearAcceptTimer } = require('./connectionState');
const { isAPNsReady, sendVoipPush } = require('./apnsService');
const { query } = require('./db');
const admin = require('firebase-admin');

// Helper to read JSON body from request
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (err) { reject(err); }
    });
  });
}

// Parse URL path (strip query string)
function parsePath(url) {
  const idx = url.indexOf('?');
  return idx === -1 ? url : url.substring(0, idx);
}

// Send JSON response
function json(res, data, statusCode = 200) {
  if (data && data.status && data.error) {
    statusCode = data.status;
    data = { error: data.error };
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Extract device identity from Authorization: Bearer <jwt>
function authenticateDevice(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try {
    return verifyToken(auth.slice(7)); // { deviceId, buildingId, role }
  } catch {
    return null;
  }
}

// Main HTTP request handler — only stateful endpoints that require in-memory connection state
async function handleRequest(req, res) {
  // --- CORS headers for all responses ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = parsePath(req.url);

  try {
    if (req.method === 'POST' && urlPath === '/decline') {
      console.log('[HTTP] Decline request received');
      const body = await readBody(req);
      const { apartmentId } = body;
      // Find the active call for this apartment
      const callInfo = apartmentId ? activeCall.getByApartment(apartmentId) : null;
      if (callInfo) {
        // Don't relay decline if someone already accepted the call
        if (callInfo.acceptedBy) {
          console.log(`[HTTP] Decline ignored — call already accepted (accepted=${callInfo.acceptedBy})`);
        } else {
          clearPendingRing(callInfo.apartmentId);
          activeCall.clear(callInfo.intercomDeviceId);
          const intercom = getIntercom(callInfo.intercomDeviceId);
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'decline' }));
            console.log(`[HTTP] Decline relayed to intercom=${callInfo.intercomDeviceId}`);
          }
        }
      } else {
        console.log('[HTTP] Decline ignored — no active call found');
      }
      json(res, { ok: true });
    } else if (req.method === 'POST' && urlPath === '/register-fcm-token') {
      const body = await readBody(req);
      const { role, token, apartmentId, userId, platform } = body;
      if (!token) { json(res, { error: 'token required' }, 400); return; }

      // If apartmentId provided, store in DB (new per-apartment flow)
      if (apartmentId && userId) {
        await query(
          `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, updated_at)
           VALUES ($1, $2, $3, 'fcm', $4, NOW())
           ON CONFLICT (token, token_type) DO UPDATE SET apartment_id = $1, user_id = $2, platform = $4, updated_at = NOW()`,
          [apartmentId, userId, token, platform || 'android']
        );
        await query(
          "DELETE FROM device_tokens WHERE user_id = $1 AND token_type = 'fcm' AND token != $2",
          [userId, token]
        );
        console.log(`[HTTP] FCM token registered for apartment=${apartmentId} user=${userId}`);
        json(res, { ok: true });
      } else if (role && token) {
        // Legacy fallback: in-memory by role
        fcmTokens.set(role, token);
        console.log(`[HTTP] FCM token registered for "${role}" (legacy)`);
        json(res, { ok: true });
      } else {
        json(res, { error: 'token and (apartmentId+userId or role) required' }, 400);
      }
    } else if (req.method === 'POST' && urlPath === '/register-voip-token') {
      const body = await readBody(req);
      const { role, token, apartmentId, userId } = body;
      if (!token) { json(res, { error: 'token required' }, 400); return; }

      // If apartmentId provided, store in DB (new per-apartment flow)
      if (apartmentId && userId) {
        await query(
          `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, updated_at)
           VALUES ($1, $2, $3, 'voip', 'ios', NOW())
           ON CONFLICT (token, token_type) DO UPDATE SET apartment_id = $1, user_id = $2, updated_at = NOW()`,
          [apartmentId, userId, token]
        );
        await query(
          "DELETE FROM device_tokens WHERE user_id = $1 AND token_type = 'voip' AND token != $2",
          [userId, token]
        );
        console.log(`[HTTP] VoIP token registered for apartment=${apartmentId} user=${userId}`);
        json(res, { ok: true });
      } else if (role && token) {
        // Legacy fallback: in-memory by role
        voipTokens.set(role, token);
        console.log(`[HTTP] VoIP token registered for "${role}" (legacy)`);
        json(res, { ok: true });
      } else {
        json(res, { error: 'token and (apartmentId+userId or role) required' }, 400);
      }
    } else if (req.method === 'POST' && urlPath === '/api/home/resolve-apartment') {
      // Resolve user email → apartment(s) via apartment_residents junction table
      const body = await readBody(req);
      const { email } = body;
      if (!email) { json(res, { error: 'email required' }, 400); return; }

      const result = await query(
        `SELECT u.id AS user_id, u.name AS user_name,
                a.id AS apartment_id, a.number AS apartment_number, a.name AS apartment_name,
                  a.building_id,
                  b.name AS building_name,
                  b.address AS building_address
         FROM users u
         JOIN apartment_residents ar ON ar.user_id = u.id
         JOIN apartments a ON a.id = ar.apartment_id
           JOIN buildings b ON b.id = a.building_id
         WHERE u.email = $1`,
        [email]
      );

      if (result.rows.length === 0) {
        json(res, { error: 'No apartment found for this user' }, 404);
        return;
      }

      // Return the first apartment (a user is typically a resident of one apartment)
      const row = result.rows[0];
      json(res, {
        userId: row.user_id,
        userName: row.user_name,
        apartmentId: row.apartment_id,
        apartmentNumber: row.apartment_number,
        apartmentName: row.apartment_name,
        buildingId: row.building_id,
        buildingName: row.building_name,
        buildingAddress: row.building_address,
      });
    } else if (req.method === 'POST' && urlPath === '/api/devices/provision') {
      const body = await readBody(req);
      const { code } = body;
      if (!code) {
        json(res, { error: 'Provisioning code required' }, 400);
        return;
      }
      const { validateProvisioningCode } = require('./devices');
      const device = await validateProvisioningCode(code);
      if (!device) {
        json(res, { error: 'Invalid or expired code' }, 401);
        return;
      }
      const token = generateDeviceToken(device.deviceId, device.buildingId);
      console.log(`[HTTP] Device provisioned: ${device.deviceId}`);
      json(res, { token, deviceId: device.deviceId, buildingId: device.buildingId });
    } else if (req.method === 'POST' && urlPath === '/api/client-error') {
      const body = await readBody(req);
      const { app, error_type, message: errMsg, stack, context,
              platform, os_version, app_version, device_model,
              user_id, user_email, apartment_id, building_id, intercom_id } = body;
      if (!app || !error_type || !errMsg) {
        json(res, { error: 'app, error_type, and message are required' }, 400);
        return;
      }
      await query(
        `INSERT INTO client_errors (app, error_type, message, stack, context,
           platform, os_version, app_version, device_model,
           user_id, user_email, apartment_id, building_id, intercom_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [app, error_type, errMsg, stack || null, context ? JSON.stringify(context) : null,
         platform || null, os_version || null, app_version || null, device_model || null,
         user_id || null, user_email || null, apartment_id || null, building_id || null, intercom_id || null]
      );
      console.log(`[HTTP] Client error logged: app=${app} type=${error_type}`);
      json(res, { ok: true });

    } else if (req.method === 'POST' && urlPath.startsWith('/api/home/calls/') && urlPath.endsWith('/ack')) {
      const parts = urlPath.split('/');
      const callId = parts[4]; // /api/home/calls/:callId/ack
      if (!callId) { json(res, { error: 'callId required' }, 400); return; }

      const body = await readBody(req);
      const { event, deviceToken, tokenType, platform, userId } = body;
      const allowedEvents = ['push-received', 'app-awake', 'incoming-ui-shown', 'accepted', 'declined'];
      if (!event || !allowedEvents.includes(event)) { json(res, { error: 'Invalid event' }, 400); return; }
      if (!deviceToken || !tokenType || !platform) { json(res, { error: 'deviceToken, tokenType, and platform are required' }, 400); return; }

      // Validate callId exists
      const callResult = await query('SELECT status FROM calls WHERE id = $1', [callId]);
      if (callResult.rows.length === 0) { json(res, { error: 'Call not found' }, 404); return; }

      await query(
        `INSERT INTO call_delivery_acks (call_id, user_id, device_token, token_type, platform, event)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [callId, userId || null, deviceToken, tokenType, platform, event]
      );
      console.log(`[HTTP] Delivery ack: call=${callId} event=${event} platform=${platform}`);
      json(res, { ok: true, callStatus: callResult.rows[0].status });

    } else if (req.method === 'GET' && urlPath === '/debug/status') {
      // Collect all active calls across intercoms
      const calls = {};
      for (const [devId, call] of activeCalls) {
        calls[devId] = {
          apartmentId: call.apartmentId,
          type: call.type,
          acceptedBy: call.acceptedBy,
          declinedCount: call.declinedBy.size,
        };
      }
      // Collect intercom connection states
      const intercomStatuses = {};
      for (const [devId, entry] of intercoms) {
        intercomStatuses[devId] = {
          buildingId: entry.buildingId,
          connected: entry.ws.readyState === 1,
        };
      }
      const status = {
        intercoms: intercomStatuses,
        activeCalls: calls,
        // Legacy single-client info
        clients: {
          intercom: clients.intercom ? (clients.intercom.readyState === 1 ? 'connected' : 'stale') : null,
        },
        fcmTokens: {
          home: fcmTokens.has('home') ? fcmTokens.get('home').substring(0, 20) + '...' : null,
          intercom: fcmTokens.has('intercom') ? fcmTokens.get('intercom').substring(0, 20) + '...' : null,
        },
        voipTokens: {
          home: voipTokens.has('home') ? voipTokens.get('home').substring(0, 20) + '...' : null,
        },
        apns: {
          ready: isAPNsReady(),
        },
      };
      json(res, status);
    } else if (req.method === 'GET' && urlPath === '/api/intercom/building-info') {
      const device = authenticateDevice(req);
      if (!device) { json(res, { error: 'Unauthorized' }, 401); return; }
      const result = await query(
        `SELECT b.id, b.name, b.address FROM buildings b WHERE b.id = $1`,
        [device.buildingId]
      );
      if (!result.rows[0]) { json(res, { error: 'Building not found' }, 404); return; }
      json(res, result.rows[0]);

    } else if (req.method === 'GET' && urlPath === '/api/intercom/apartments') {
      const device = authenticateDevice(req);
      if (!device) { json(res, { error: 'Unauthorized' }, 401); return; }
      const result = await query(
        `SELECT id, number, name FROM apartments WHERE building_id = $1 ORDER BY number`,
        [device.buildingId]
      );
      json(res, result.rows);

    } else if (req.method === 'POST' && urlPath === '/api/intercom/verify-door-code') {
      const device = authenticateDevice(req);
      if (!device) { json(res, { error: 'Unauthorized' }, 401); return; }
      const body = await readBody(req);
      const { code } = body;
      if (!code) { json(res, { error: 'Code required' }, 400); return; }
      const result = await query(
        `SELECT door_code FROM intercoms WHERE id = $1`,
        [device.deviceId]
      );
      const intercom = result.rows[0];
      if (!intercom || !intercom.door_code) { json(res, { valid: false }, 200); return; }
      const valid = intercom.door_code === code;
      json(res, { valid, ...(valid ? {} : { expected: intercom.door_code }) });

    } else if (req.method === 'POST' && urlPath.startsWith('/api/home/calls/') && urlPath.endsWith('/accept')) {
      // ---- A6: HTTP accept — reserve the call before WS connects ----
      const parts = urlPath.split('/');
      const callId = parts[4]; // /api/home/calls/:callId/accept
      if (!callId) { json(res, { error: 'callId required' }, 400); return; }

      const body = await readBody(req);
      const { userId } = body;
      if (!userId) { json(res, { error: 'userId required' }, 400); return; }

      // Look up current call status
      const callResult = await query('SELECT id, status, apartment_id, intercom_id, building_id FROM calls WHERE id = $1', [callId]);
      if (callResult.rows.length === 0) { json(res, { error: 'Call not found' }, 404); return; }
      const callRow = callResult.rows[0];

      // If not in 'calling' status, return current status so app knows immediately
      if (callRow.status !== 'calling') {
        const mapped = callRow.status === 'accepted' ? 'call-taken' : callRow.status;
        json(res, { status: mapped, callId });
        return;
      }

      // Atomically claim the call
      const updateResult = await query(
        "UPDATE calls SET status = 'accepted', updated_at = NOW() WHERE id = $1 AND status = 'calling' RETURNING *",
        [callId]
      );
      if (updateResult.rows.length === 0) {
        // Race lost — re-read status
        const recheck = await query('SELECT status FROM calls WHERE id = $1', [callId]);
        const mapped = recheck.rows[0]?.status === 'accepted' ? 'call-taken' : (recheck.rows[0]?.status || 'ended');
        json(res, { status: mapped, callId });
        return;
      }

      console.log(`[HTTP] Call ${callId} accepted via HTTP by user=${userId}`);

      // Audit log
      query("INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, call_id, description) VALUES ('call-accepted', $1, $2, $3, $4, 'Call accepted via HTTP')",
        [callRow.building_id, callRow.apartment_id, callRow.intercom_id, callId]
      ).catch(e => console.error('[DB] http-accept audit_log:', e.message));

      // Update in-memory state
      const httpAccepted = activeCall.httpAccept(callRow.intercom_id, userId);
      if (httpAccepted) {
        clearPendingRing(callRow.apartment_id);
      }

      // Notify intercom WS that the call was accepted
      const intercom = getIntercom(callRow.intercom_id);
      if (intercom && intercom.ws.readyState === 1) {
        intercom.ws.send(JSON.stringify({ type: 'accept', callId }));
      }

      // Send call-taken to all connected home WS clients
      const aptClients = getHomeClients(callRow.apartment_id);
      for (const [, entry] of aptClients) {
        if (entry.ws.readyState === 1) {
          entry.ws.send(JSON.stringify({ type: 'call-taken', callId }));
        }
      }

      // Send call-taken push to all registered tokens for the apartment
      try {
        const tokenResult = await query(
          'SELECT token, token_type FROM device_tokens WHERE apartment_id = $1',
          [callRow.apartment_id]
        );
        for (const row of tokenResult.rows) {
          if (row.token_type === 'voip' && isAPNsReady()) {
            sendVoipPush(row.token, 'call-taken', { type: 'call-taken', callId })
              .catch(err => console.error('[HTTP] call-taken VoIP push error:', err.message));
          } else if (row.token_type === 'fcm') {
            admin.messaging().send({
              token: row.token,
              data: { type: 'call-taken', callId },
              android: { priority: 'high' },
            }).catch(err => console.error('[HTTP] call-taken FCM error:', err.message));
          }
        }
      } catch (err) {
        console.error('[HTTP] Error sending call-taken push:', err.message);
      }

      // Start accept reservation timer (10s) — if device doesn't send offer via WS, revert
      startAcceptTimer(callId, 10_000, async () => {
        console.log(`[HTTP] Accept reservation expired for call=${callId}, reverting to calling`);
        // Revert DB
        const revertResult = await query(
          "UPDATE calls SET status = 'calling', updated_at = NOW() WHERE id = $1 AND status = 'accepted' RETURNING *",
          [callId]
        ).catch(e => { console.error('[DB] accept-timeout revert:', e.message); return { rows: [] }; });
        if (revertResult.rows.length === 0) return; // call already ended/changed

        // Audit log
        query("INSERT INTO audit_logs (event_type, building_id, apartment_id, intercom_id, call_id, description) VALUES ('accept-timeout', $1, $2, $3, $4, 'HTTP accept reservation expired — device did not connect')",
          [callRow.building_id, callRow.apartment_id, callRow.intercom_id, callId]
        ).catch(e => console.error('[DB] accept-timeout audit_log:', e.message));

        // Clear in-memory accept
        const call = activeCall.get(callRow.intercom_id);
        if (call && call.httpAcceptedBy === userId) {
          call.acceptedBy = null;
          call.acceptedWs = null;
          call.httpAcceptedBy = null;
        }

        // Notify intercom that accept lapsed
        const ic = getIntercom(callRow.intercom_id);
        if (ic && ic.ws.readyState === 1) {
          ic.ws.send(JSON.stringify({ type: 'accept-timeout', callId }));
        }

        // Re-ring all home devices (WS)
        sendToApartment(callRow.apartment_id, { type: 'ring', callId });

        // Re-send push notifications
        try {
          const tokenResult = await query(
            'SELECT token, token_type, platform FROM device_tokens WHERE apartment_id = $1',
            [callRow.apartment_id]
          );
          for (const row of tokenResult.rows) {
            if (row.token_type === 'voip' && isAPNsReady()) {
              sendVoipPush(row.token, 'Intercom', { callerName: 'Intercom', type: 'incoming-call', callId })
                .catch(err => console.error('[HTTP] re-ring VoIP push error:', err.message));
            } else if (row.token_type === 'fcm') {
              admin.messaging().send({
                token: row.token,
                data: { type: 'incoming-call', callerName: 'Intercom', apartmentId: callRow.apartment_id, callId },
                android: { priority: 'high' },
              }).catch(err => console.error('[HTTP] re-ring FCM error:', err.message));
            }
          }
        } catch (err) {
          console.error('[HTTP] Error re-ringing after accept timeout:', err.message);
        }
      });

      json(res, { status: 'accepted', callId });

    } else {
      res.writeHead(404);
      res.end();
    }
  } catch (err) {
    console.error(`[HTTP] Error handling ${req.method} ${urlPath}:`, err);
    json(res, { error: 'Internal server error' }, 500);
  }
}

module.exports = { handleRequest };
