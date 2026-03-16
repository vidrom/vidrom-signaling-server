// HTTP route handler — EC2-resident endpoints only
// Portal APIs (/api/admin/*, /api/management/*) have moved to Lambda (see ../lambda/)
// Portal HTML (admin.html, management.html) served from S3+CloudFront (see ../portals/)
const { generateDeviceToken, verifyToken } = require('./auth');
const { clients, fcmTokens, voipTokens, clearPendingRing, isPendingRing } = require('./connectionState');
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
      clearPendingRing();
      if (clients.intercom && clients.intercom.readyState === 1) {
        clients.intercom.send(JSON.stringify({ type: 'decline' }));
        console.log('[HTTP] Decline relayed to intercom');
      }
      json(res, { ok: true });
    } else if (req.method === 'POST' && urlPath === '/register-fcm-token') {
      const body = await readBody(req);
      const { role, token } = body;
      if (role && token) {
        fcmTokens.set(role, token);
        console.log(`[HTTP] FCM token registered for "${role}"`);
        json(res, { ok: true });
      } else {
        json(res, { error: 'role and token required' }, 400);
      }
    } else if (req.method === 'POST' && urlPath === '/register-voip-token') {
      const body = await readBody(req);
      const { role, token } = body;
      if (role && token) {
        voipTokens.set(role, token);
        console.log(`[HTTP] VoIP token registered for "${role}"`);
        json(res, { ok: true });
      } else {
        json(res, { error: 'role and token required' }, 400);
      }
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
    } else if (req.method === 'GET' && urlPath === '/debug/status') {
      const status = {
        clients: {
          home: clients.home ? (clients.home.readyState === 1 ? 'connected' : 'stale') : null,
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
        pendingRing: isPendingRing(),
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
