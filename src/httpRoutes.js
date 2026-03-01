// HTTP route handler — REST API endpoints and admin page serving
const fs = require('fs');
const path = require('path');
const { verifyAdminToken } = require('./adminAuth');
const { generateDeviceToken } = require('./auth');
const { createDevice, validateProvisioningCode, revokeDevice, listDevices } = require('./devices');
const { clients, fcmTokens, clearPendingRing } = require('./connectionState');

// Helper to read JSON body from request
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (err) { reject(err); }
    });
  });
}

// Main HTTP request handler
async function handleRequest(req, res) {
  // --- CORS headers for all responses ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- Serve admin portal ---
  if (req.method === 'GET' && req.url === '/admin') {
    const htmlPath = path.join(__dirname, '..', 'admin.html');
    fs.readFile(htmlPath, 'utf8', (err, html) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading admin page');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    return;
  }

  // --- Admin auth check for /api/admin/* routes ---
  if (req.url.startsWith('/api/admin/')) {
    const adminUser = await verifyAdminToken(req);
    if (!adminUser) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    console.log(`[ADMIN] Authenticated: ${adminUser.email}`);
  }

  // --- Route matching ---
  if (req.method === 'POST' && req.url === '/decline') {
    // Background decline from notification action (no WebSocket available)
    console.log('[HTTP] Decline request received');
    clearPendingRing();
    if (clients.intercom && clients.intercom.readyState === 1) {
      clients.intercom.send(JSON.stringify({ type: 'decline' }));
      console.log('[HTTP] Decline relayed to intercom');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.method === 'POST' && req.url === '/register-fcm-token') {
    // Register FCM token via HTTP (so home app doesn't need persistent WS)
    readBody(req).then(({ role, token }) => {
      if (role && token) {
        fcmTokens.set(role, token);
        console.log(`[HTTP] FCM token registered for "${role}"`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'role and token required' }));
      }
    }).catch(() => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    });
  } else if (req.method === 'GET' && req.url === '/api/admin/devices') {
    // Admin: List all devices
    const allDevices = listDevices();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(allDevices));
  } else if (req.method === 'POST' && req.url === '/api/admin/devices') {
    // Admin: Create a new device (returns provisioning code)
    readBody(req).then(({ buildingId, name }) => {
      if (!buildingId || !name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'buildingId and name required' }));
        return;
      }
      const { deviceId, code } = createDevice(buildingId, name);
      console.log(`[HTTP] Device created: ${deviceId} (code: ${code})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deviceId, provisioningCode: code }));
    }).catch(() => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    });
  } else if (req.method === 'POST' && req.url === '/api/devices/provision') {
    // Device: Exchange provisioning code for JWT
    readBody(req).then(({ code }) => {
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Provisioning code required' }));
        return;
      }
      const device = validateProvisioningCode(code);
      if (!device) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired code' }));
        return;
      }
      const token = generateDeviceToken(device.deviceId, device.buildingId);
      console.log(`[HTTP] Device provisioned: ${device.deviceId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token, deviceId: device.deviceId, buildingId: device.buildingId }));
    }).catch(() => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    });
  } else if (req.method === 'POST' && req.url.startsWith('/api/admin/devices/') && req.url.endsWith('/revoke')) {
    // Admin: Revoke a device
    const parts = req.url.split('/');
    const deviceId = parts[4]; // /api/admin/devices/:deviceId/revoke
    revokeDevice(deviceId);
    console.log(`[HTTP] Device revoked: ${deviceId}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } else {
    res.writeHead(404);
    res.end();
  }
}

module.exports = { handleRequest };
