// HTTP route handler — REST API endpoints and portal serving
const fs = require('fs');
const path = require('path');
const { verifyAdminToken, verifyManagementToken } = require('./adminAuth');
const { generateDeviceToken } = require('./auth');
const { clients, fcmTokens, voipTokens, clearPendingRing } = require('./connectionState');
const adminRoutes = require('./adminRoutes');
const managementRoutes = require('./managementRoutes');

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

// Parse URL query string
function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = {};
  const pairs = url.substring(idx + 1).split('&');
  for (const pair of pairs) {
    const [key, val] = pair.split('=');
    if (key) params[decodeURIComponent(key)] = decodeURIComponent(val || '');
  }
  return params;
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

// Main HTTP request handler
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
  const queryParams = parseQuery(req.url);

  try {
    // ═══════════════════════════════════════════════════════════
    // Serve portal HTML files
    // ═══════════════════════════════════════════════════════════

    if (req.method === 'GET' && urlPath === '/admin') {
      const htmlPath = path.join(__dirname, '..', 'admin.html');
      fs.readFile(htmlPath, 'utf8', (err, html) => {
        if (err) { res.writeHead(500); res.end('Error loading admin page'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      });
      return;
    }

    if (req.method === 'GET' && urlPath === '/management') {
      const htmlPath = path.join(__dirname, '..', 'management.html');
      fs.readFile(htmlPath, 'utf8', (err, html) => {
        if (err) { res.writeHead(500); res.end('Error loading management page'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      });
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // Admin API routes (/api/admin/*)
    // ═══════════════════════════════════════════════════════════

    if (urlPath.startsWith('/api/admin/')) {
      const adminUser = await verifyAdminToken(req);
      if (!adminUser) {
        json(res, { error: 'Unauthorized' }, 401);
        return;
      }
      console.log(`[ADMIN] ${req.method} ${urlPath} — ${adminUser.email}`);

      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};

      // --- Buildings ---
      if (req.method === 'GET' && urlPath === '/api/admin/buildings') {
        return json(res, await adminRoutes.listBuildings());
      }
      if (req.method === 'POST' && urlPath === '/api/admin/buildings') {
        return json(res, await adminRoutes.createBuilding(body));
      }
      const buildingMatch = urlPath.match(/^\/api\/admin\/buildings\/([^/]+)$/);
      if (buildingMatch && req.method === 'PUT') {
        return json(res, await adminRoutes.updateBuilding(buildingMatch[1], body));
      }
      if (buildingMatch && req.method === 'DELETE') {
        return json(res, await adminRoutes.deleteBuilding(buildingMatch[1]));
      }

      // --- Apartments under building ---
      const bldgAptMatch = urlPath.match(/^\/api\/admin\/buildings\/([^/]+)\/apartments$/);
      if (bldgAptMatch && req.method === 'GET') {
        return json(res, await adminRoutes.listApartments(bldgAptMatch[1]));
      }
      if (bldgAptMatch && req.method === 'POST') {
        return json(res, await adminRoutes.createApartment(bldgAptMatch[1], body));
      }

      // --- Apartments direct ---
      const aptMatch = urlPath.match(/^\/api\/admin\/apartments\/([^/]+)$/);
      if (aptMatch && req.method === 'PUT') {
        return json(res, await adminRoutes.updateApartment(aptMatch[1], body));
      }
      if (aptMatch && req.method === 'DELETE') {
        return json(res, await adminRoutes.deleteApartment(aptMatch[1]));
      }

      // --- Users ---
      if (req.method === 'GET' && urlPath === '/api/admin/users') {
        return json(res, await adminRoutes.listUsers());
      }
      if (req.method === 'POST' && urlPath === '/api/admin/users') {
        return json(res, await adminRoutes.createUser(body));
      }
      const userMatch = urlPath.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (userMatch && req.method === 'PUT') {
        return json(res, await adminRoutes.updateUser(userMatch[1], body));
      }
      if (userMatch && req.method === 'DELETE') {
        return json(res, await adminRoutes.deleteUser(userMatch[1]));
      }

      // --- Building Managers ---
      const bldgMgrMatch = urlPath.match(/^\/api\/admin\/buildings\/([^/]+)\/managers$/);
      if (bldgMgrMatch && req.method === 'GET') {
        return json(res, await adminRoutes.listBuildingManagers(bldgMgrMatch[1]));
      }
      if (bldgMgrMatch && req.method === 'POST') {
        return json(res, await adminRoutes.assignManager(bldgMgrMatch[1], body));
      }
      const removeMgrMatch = urlPath.match(/^\/api\/admin\/buildings\/([^/]+)\/managers\/([^/]+)$/);
      if (removeMgrMatch && req.method === 'DELETE') {
        return json(res, await adminRoutes.removeManager(removeMgrMatch[1], removeMgrMatch[2]));
      }

      // --- Apartment Residents ---
      const aptResMatch = urlPath.match(/^\/api\/admin\/apartments\/([^/]+)\/residents$/);
      if (aptResMatch && req.method === 'GET') {
        return json(res, await adminRoutes.listApartmentResidents(aptResMatch[1]));
      }
      if (aptResMatch && req.method === 'POST') {
        return json(res, await adminRoutes.assignResident(aptResMatch[1], body));
      }
      const removeResMatch = urlPath.match(/^\/api\/admin\/apartments\/([^/]+)\/residents\/([^/]+)$/);
      if (removeResMatch && req.method === 'DELETE') {
        return json(res, await adminRoutes.removeResident(removeResMatch[1], removeResMatch[2]));
      }

      // --- Devices (Intercoms) ---
      if (req.method === 'GET' && urlPath === '/api/admin/devices') {
        return json(res, await adminRoutes.listDevices());
      }
      if (req.method === 'POST' && urlPath === '/api/admin/devices') {
        return json(res, await adminRoutes.createDevice(body));
      }
      const devMatch = urlPath.match(/^\/api\/admin\/devices\/([^/]+)$/);
      if (devMatch && req.method === 'PUT') {
        return json(res, await adminRoutes.updateDevice(devMatch[1], body));
      }
      if (devMatch && req.method === 'DELETE') {
        return json(res, await adminRoutes.deleteDevice(devMatch[1]));
      }
      const revokeMatch = urlPath.match(/^\/api\/admin\/devices\/([^/]+)\/revoke$/);
      if (revokeMatch && req.method === 'POST') {
        return json(res, await adminRoutes.revokeDevice(revokeMatch[1]));
      }

      // --- Notifications ---
      if (req.method === 'GET' && urlPath === '/api/admin/notifications') {
        return json(res, await adminRoutes.listNotifications());
      }
      if (req.method === 'POST' && urlPath === '/api/admin/notifications') {
        return json(res, await adminRoutes.createNotification(body));
      }
      const notifMatch = urlPath.match(/^\/api\/admin\/notifications\/([^/]+)$/);
      if (notifMatch && req.method === 'DELETE') {
        return json(res, await adminRoutes.deleteNotification(notifMatch[1]));
      }

      // --- Audit Logs ---
      if (req.method === 'GET' && urlPath === '/api/admin/audit-logs') {
        return json(res, await adminRoutes.listAuditLogs(queryParams));
      }

      // --- Global Settings ---
      if (req.method === 'GET' && urlPath === '/api/admin/settings') {
        return json(res, await adminRoutes.listSettings());
      }
      const settingMatch = urlPath.match(/^\/api\/admin\/settings\/([^/]+)$/);
      if (settingMatch && req.method === 'PUT') {
        return json(res, await adminRoutes.updateSetting(decodeURIComponent(settingMatch[1]), body));
      }

      json(res, { error: 'Not found' }, 404);
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // Management API routes (/api/management/*)
    // ═══════════════════════════════════════════════════════════

    if (urlPath.startsWith('/api/management/')) {
      const mgmtUser = await verifyManagementToken(req);
      if (!mgmtUser) {
        json(res, { error: 'Unauthorized' }, 401);
        return;
      }
      console.log(`[MGMT] ${req.method} ${urlPath} — ${mgmtUser.email} (buildings: ${mgmtUser.buildingIds.length})`);
      const buildingIds = mgmtUser.buildingIds;
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};

      // --- Buildings ---
      if (req.method === 'GET' && urlPath === '/api/management/buildings') {
        return json(res, await managementRoutes.listBuildings(buildingIds));
      }
      const bldgMatch = urlPath.match(/^\/api\/management\/buildings\/([^/]+)$/);
      if (bldgMatch && req.method === 'PUT') {
        return json(res, await managementRoutes.updateBuilding(buildingIds, bldgMatch[1], body));
      }

      // --- Apartments ---
      const bldgAptMatch = urlPath.match(/^\/api\/management\/buildings\/([^/]+)\/apartments$/);
      if (bldgAptMatch && req.method === 'GET') {
        return json(res, await managementRoutes.listApartments(buildingIds, bldgAptMatch[1]));
      }
      if (bldgAptMatch && req.method === 'POST') {
        return json(res, await managementRoutes.createApartment(buildingIds, bldgAptMatch[1], body));
      }
      const aptMatch = urlPath.match(/^\/api\/management\/apartments\/([^/]+)$/);
      if (aptMatch && req.method === 'PUT') {
        return json(res, await managementRoutes.updateApartment(buildingIds, aptMatch[1], body));
      }
      if (aptMatch && req.method === 'DELETE') {
        return json(res, await managementRoutes.deleteApartment(buildingIds, aptMatch[1]));
      }

      // --- Residents ---
      const aptResMatch = urlPath.match(/^\/api\/management\/apartments\/([^/]+)\/residents$/);
      if (aptResMatch && req.method === 'GET') {
        return json(res, await managementRoutes.listResidents(buildingIds, aptResMatch[1]));
      }
      if (aptResMatch && req.method === 'POST') {
        return json(res, await managementRoutes.assignResident(buildingIds, aptResMatch[1], body));
      }
      const removeResMatch = urlPath.match(/^\/api\/management\/apartments\/([^/]+)\/residents\/([^/]+)$/);
      if (removeResMatch && req.method === 'DELETE') {
        return json(res, await managementRoutes.removeResident(buildingIds, removeResMatch[1], removeResMatch[2]));
      }

      // --- Devices ---
      if (req.method === 'GET' && urlPath === '/api/management/devices') {
        return json(res, await managementRoutes.listDevices(buildingIds));
      }
      if (req.method === 'POST' && urlPath === '/api/management/devices') {
        return json(res, await managementRoutes.createDevice(buildingIds, body));
      }
      const revokeMatch = urlPath.match(/^\/api\/management\/devices\/([^/]+)\/revoke$/);
      if (revokeMatch && req.method === 'POST') {
        return json(res, await managementRoutes.revokeDevice(buildingIds, revokeMatch[1]));
      }

      // --- Notifications ---
      if (req.method === 'GET' && urlPath === '/api/management/notifications') {
        return json(res, await managementRoutes.listNotifications(buildingIds));
      }
      if (req.method === 'POST' && urlPath === '/api/management/notifications') {
        return json(res, await managementRoutes.createNotification(buildingIds, body));
      }
      const notifMatch = urlPath.match(/^\/api\/management\/notifications\/([^/]+)$/);
      if (notifMatch && req.method === 'DELETE') {
        return json(res, await managementRoutes.deleteNotification(buildingIds, notifMatch[1]));
      }

      // --- Audit Logs ---
      if (req.method === 'GET' && urlPath === '/api/management/audit-logs') {
        return json(res, await managementRoutes.listAuditLogs(buildingIds, queryParams));
      }

      json(res, { error: 'Not found' }, 404);
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // Legacy / App routes
    // ═══════════════════════════════════════════════════════════

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
