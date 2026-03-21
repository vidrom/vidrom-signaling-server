// HTTP route handler — EC2-resident endpoints only
// Portal APIs (/api/admin/*, /api/management/*) have moved to Lambda (see ../lambda/)
// Portal HTML (admin.html, management.html) served from S3+CloudFront (see ../portals/)
const { generateDeviceToken, verifyToken } = require('./auth');
const { clients, fcmTokens, voipTokens, activeCall, activeCalls, intercoms, getIntercom, getIntercomForBuilding, clearPendingRing, isPendingRing, sendToApartment } = require('./connectionState');
const { isAPNsReady } = require('./apnsService');
const { query } = require('./db');

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
        clearPendingRing(callInfo.apartmentId);
        activeCall.clear(callInfo.intercomDeviceId);
        const intercom = getIntercom(callInfo.intercomDeviceId);
        if (intercom && intercom.ws.readyState === 1) {
          intercom.ws.send(JSON.stringify({ type: 'decline' }));
          console.log(`[HTTP] Decline relayed to intercom=${callInfo.intercomDeviceId}`);
        }
      } else if (clients.intercom && clients.intercom.readyState === 1) {
        // Legacy fallback — clear all
        clients.intercom.send(JSON.stringify({ type: 'decline' }));
        console.log('[HTTP] Decline relayed to intercom (legacy)');
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
