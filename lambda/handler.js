// Lambda entry point — routes API Gateway events to admin/management handlers
const { verifyAdminToken, verifyManagementToken } = require('./adminAuth');
const adminRoutes = require('./adminRoutes');
const managementRoutes = require('./managementRoutes');
const {
  checkPortalAuthRateLimit,
  checkPortalSensitiveRateLimit,
  getClientIp,
  getRateLimitError,
  getRateLimitHeaders,
} = require('./rateLimit');
const { redactEmail, summarizeError } = require('./logging');

const DEFAULT_PORTAL_ORIGINS = ['https://portal.vidrom.com'];

function getAllowedOrigins() {
  const configured = process.env.ALLOWED_PORTAL_ORIGINS;
  if (!configured) {
    return DEFAULT_PORTAL_ORIGINS;
  }

  return configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function buildHeaders(requestOrigin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    Vary: 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };

  if (requestOrigin && getAllowedOrigins().includes(requestOrigin)) {
    headers['Access-Control-Allow-Origin'] = requestOrigin;
  }

  return headers;
};

function json(statusCode, data, requestOrigin, extraHeaders = {}) {
  if (data && data.status && data.error) {
    statusCode = data.status;
    data = { error: data.error };
  }
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...buildHeaders(requestOrigin), ...extraHeaders },
    body: JSON.stringify(data),
  };
}

exports.handler = async (event) => {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const queryParams = event.queryStringParameters || {};
  const requestOrigin = (event.headers && (event.headers.origin || event.headers.Origin)) || null;
  const clientIp = getClientIp(event);

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: buildHeaders(requestOrigin) };
  }

  const authLimit = checkPortalAuthRateLimit(path, clientIp);
  if (authLimit && authLimit.limited) {
    return json(429, { error: getRateLimitError(authLimit) }, requestOrigin, getRateLimitHeaders(authLimit));
  }

  // Minimal req-like object for auth functions (they read req.headers['authorization'])
  const req = { headers: event.headers || {} };

  let body = {};
  if (event.body) {
    try {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString()
        : event.body;
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: 'Invalid JSON body' }, requestOrigin);
    }
  }

  try {
    // ═══════════════════════════════════════════════════════════
    // Admin API routes (/api/admin/*)
    // ═══════════════════════════════════════════════════════════
    if (path.startsWith('/api/admin/')) {
      const adminUser = await verifyAdminToken(req);
      if (!adminUser) return json(401, { error: 'Unauthorized' }, requestOrigin);
      const adminRateLimit = checkPortalSensitiveRateLimit(
        method,
        path,
        adminUser.userId || adminUser.email,
        clientIp,
      );
      if (adminRateLimit && adminRateLimit.limited) {
        return json(429, { error: getRateLimitError(adminRateLimit) }, requestOrigin, getRateLimitHeaders(adminRateLimit));
      }
      console.log(`[ADMIN] ${method} ${path} — ${redactEmail(adminUser.email)}`);

      // --- Buildings ---
      if (method === 'GET' && path === '/api/admin/buildings') {
        return json(200, await adminRoutes.listBuildings(), requestOrigin);
      }
      if (method === 'POST' && path === '/api/admin/buildings') {
        return json(200, await adminRoutes.createBuilding(body), requestOrigin);
      }
      const buildingMatch = path.match(/^\/api\/admin\/buildings\/([^/]+)$/);
      if (buildingMatch && method === 'PUT') {
        return json(200, await adminRoutes.updateBuilding(buildingMatch[1], body), requestOrigin);
      }
      if (buildingMatch && method === 'DELETE') {
        return json(200, await adminRoutes.deleteBuilding(buildingMatch[1]), requestOrigin);
      }

      // --- Apartments under building ---
      const bldgAptMatch = path.match(/^\/api\/admin\/buildings\/([^/]+)\/apartments$/);
      if (bldgAptMatch && method === 'GET') {
        return json(200, await adminRoutes.listApartments(bldgAptMatch[1]), requestOrigin);
      }
      if (bldgAptMatch && method === 'POST') {
        return json(200, await adminRoutes.createApartment(bldgAptMatch[1], body), requestOrigin);
      }

      // --- Apartments direct ---
      const aptMatch = path.match(/^\/api\/admin\/apartments\/([^/]+)$/);
      if (aptMatch && method === 'PUT') {
        return json(200, await adminRoutes.updateApartment(aptMatch[1], body), requestOrigin);
      }
      if (aptMatch && method === 'DELETE') {
        return json(200, await adminRoutes.deleteApartment(aptMatch[1]), requestOrigin);
      }

      // --- Users ---
      if (method === 'GET' && path === '/api/admin/users') {
        return json(200, await adminRoutes.listUsers(), requestOrigin);
      }
      if (method === 'POST' && path === '/api/admin/users') {
        return json(200, await adminRoutes.createUser(body), requestOrigin);
      }
      const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (userMatch && method === 'PUT') {
        return json(200, await adminRoutes.updateUser(userMatch[1], body), requestOrigin);
      }
      if (userMatch && method === 'DELETE') {
        return json(200, await adminRoutes.deleteUser(userMatch[1]), requestOrigin);
      }

      // --- Building Managers ---
      const bldgMgrMatch = path.match(/^\/api\/admin\/buildings\/([^/]+)\/managers$/);
      if (bldgMgrMatch && method === 'GET') {
        return json(200, await adminRoutes.listBuildingManagers(bldgMgrMatch[1]), requestOrigin);
      }
      if (bldgMgrMatch && method === 'POST') {
        return json(200, await adminRoutes.assignManager(bldgMgrMatch[1], body), requestOrigin);
      }
      const removeMgrMatch = path.match(/^\/api\/admin\/buildings\/([^/]+)\/managers\/([^/]+)$/);
      if (removeMgrMatch && method === 'DELETE') {
        return json(200, await adminRoutes.removeManager(removeMgrMatch[1], removeMgrMatch[2]), requestOrigin);
      }

      // --- Apartment Residents ---
      const aptResMatch = path.match(/^\/api\/admin\/apartments\/([^/]+)\/residents$/);
      if (aptResMatch && method === 'GET') {
        return json(200, await adminRoutes.listApartmentResidents(aptResMatch[1]), requestOrigin);
      }
      if (aptResMatch && method === 'POST') {
        return json(200, await adminRoutes.assignResident(aptResMatch[1], body), requestOrigin);
      }
      const removeResMatch = path.match(/^\/api\/admin\/apartments\/([^/]+)\/residents\/([^/]+)$/);
      if (removeResMatch && method === 'DELETE') {
        return json(200, await adminRoutes.removeResident(removeResMatch[1], removeResMatch[2]), requestOrigin);
      }

      // --- Devices (Intercoms) ---
      if (method === 'GET' && path === '/api/admin/devices') {
        return json(200, await adminRoutes.listDevices(), requestOrigin);
      }
      if (method === 'POST' && path === '/api/admin/devices') {
        return json(200, await adminRoutes.createDevice(body), requestOrigin);
      }
      const devMatch = path.match(/^\/api\/admin\/devices\/([^/]+)$/);
      if (devMatch && method === 'PUT') {
        return json(200, await adminRoutes.updateDevice(devMatch[1], body), requestOrigin);
      }
      if (devMatch && method === 'DELETE') {
        return json(200, await adminRoutes.deleteDevice(devMatch[1]), requestOrigin);
      }
      const revokeMatch = path.match(/^\/api\/admin\/devices\/([^/]+)\/revoke$/);
      if (revokeMatch && method === 'POST') {
        return json(200, await adminRoutes.revokeDevice(revokeMatch[1]), requestOrigin);
      }
      const reprovisionMatch = path.match(/^\/api\/admin\/devices\/([^/]+)\/reprovision$/);
      if (reprovisionMatch && method === 'POST') {
        return json(200, await adminRoutes.reprovisionDevice(reprovisionMatch[1]), requestOrigin);
      }

      // --- Notifications ---
      if (method === 'GET' && path === '/api/admin/notifications') {
        return json(200, await adminRoutes.listNotifications(), requestOrigin);
      }
      if (method === 'POST' && path === '/api/admin/notifications') {
        return json(200, await adminRoutes.createNotification(body), requestOrigin);
      }
      const notifMatch = path.match(/^\/api\/admin\/notifications\/([^/]+)$/);
      if (notifMatch && method === 'DELETE') {
        return json(200, await adminRoutes.deleteNotification(notifMatch[1]), requestOrigin);
      }

      // --- Audit Logs ---
      if (method === 'GET' && path === '/api/admin/audit-logs') {
        return json(200, await adminRoutes.listAuditLogs(queryParams), requestOrigin);
      }

      // --- Client Errors ---
      if (method === 'GET' && path === '/api/admin/client-errors') {
        return json(200, await adminRoutes.listClientErrors(queryParams), requestOrigin);
      }

      // --- Global Settings ---
      if (method === 'GET' && path === '/api/admin/settings') {
        return json(200, await adminRoutes.listSettings(), requestOrigin);
      }
      const settingMatch = path.match(/^\/api\/admin\/settings\/([^/]+)$/);
      if (settingMatch && method === 'PUT') {
        return json(200, await adminRoutes.updateSetting(decodeURIComponent(settingMatch[1]), body), requestOrigin);
      }

      // --- Delivery Health ---
      if (method === 'GET' && path === '/api/admin/delivery-health') {
        return json(200, await adminRoutes.getSystemDeliveryHealth(), requestOrigin);
      }

      // --- Device Health ---
      if (method === 'GET' && path === '/api/admin/device-health/summary') {
        return json(200, await adminRoutes.getSystemDeviceHealthSummary(), requestOrigin);
      }

      return json(404, { error: 'Not found' }, requestOrigin);
    }

    // ═══════════════════════════════════════════════════════════
    // Management API routes (/api/management/*)
    // ═══════════════════════════════════════════════════════════
    if (path.startsWith('/api/management/')) {
      const mgmtUser = await verifyManagementToken(req);
      if (!mgmtUser) return json(401, { error: 'Unauthorized' }, requestOrigin);
      const managementRateLimit = checkPortalSensitiveRateLimit(
        method,
        path,
        mgmtUser.userId || mgmtUser.email,
        clientIp,
      );
      if (managementRateLimit && managementRateLimit.limited) {
        return json(429, { error: getRateLimitError(managementRateLimit) }, requestOrigin, getRateLimitHeaders(managementRateLimit));
      }
      console.log(`[MGMT] ${method} ${path} — ${redactEmail(mgmtUser.email)} (buildings: ${mgmtUser.buildingIds.length})`);
      const buildingIds = mgmtUser.buildingIds;

      // --- Buildings ---
      if (method === 'GET' && path === '/api/management/buildings') {
        return json(200, await managementRoutes.listBuildings(buildingIds), requestOrigin);
      }
      const bldgMatch = path.match(/^\/api\/management\/buildings\/([^/]+)$/);
      if (bldgMatch && method === 'PUT') {
        return json(200, await managementRoutes.updateBuilding(buildingIds, bldgMatch[1], body), requestOrigin);
      }

      // --- Apartments ---
      const bldgAptMatch = path.match(/^\/api\/management\/buildings\/([^/]+)\/apartments$/);
      if (bldgAptMatch && method === 'GET') {
        return json(200, await managementRoutes.listApartments(buildingIds, bldgAptMatch[1]), requestOrigin);
      }
      if (bldgAptMatch && method === 'POST') {
        return json(200, await managementRoutes.createApartment(buildingIds, bldgAptMatch[1], body), requestOrigin);
      }
      const bldgDeviceHealthMatch = path.match(/^\/api\/management\/buildings\/([^/]+)\/device-health$/);
      if (bldgDeviceHealthMatch && method === 'GET') {
        return json(200, await managementRoutes.getDeviceHealth(buildingIds, bldgDeviceHealthMatch[1]), requestOrigin);
      }
      const aptMatch = path.match(/^\/api\/management\/apartments\/([^/]+)$/);
      if (aptMatch && method === 'PUT') {
        return json(200, await managementRoutes.updateApartment(buildingIds, aptMatch[1], body), requestOrigin);
      }
      if (aptMatch && method === 'DELETE') {
        return json(200, await managementRoutes.deleteApartment(buildingIds, aptMatch[1]), requestOrigin);
      }

      // --- Residents ---
      const aptResMatch = path.match(/^\/api\/management\/apartments\/([^/]+)\/residents$/);
      if (aptResMatch && method === 'GET') {
        return json(200, await managementRoutes.listResidents(buildingIds, aptResMatch[1]), requestOrigin);
      }
      if (aptResMatch && method === 'POST') {
        return json(200, await managementRoutes.assignResident(buildingIds, aptResMatch[1], body), requestOrigin);
      }
      const removeResMatch = path.match(/^\/api\/management\/apartments\/([^/]+)\/residents\/([^/]+)$/);
      if (removeResMatch && method === 'DELETE') {
        return json(200, await managementRoutes.removeResident(buildingIds, removeResMatch[1], removeResMatch[2]), requestOrigin);
      }

      // --- Devices ---
      if (method === 'GET' && path === '/api/management/devices') {
        return json(200, await managementRoutes.listDevices(buildingIds), requestOrigin);
      }
      if (method === 'POST' && path === '/api/management/devices') {
        return json(200, await managementRoutes.createDevice(buildingIds, body), requestOrigin);
      }
      const revokeMatch = path.match(/^\/api\/management\/devices\/([^/]+)\/revoke$/);
      if (revokeMatch && method === 'POST') {
        return json(200, await managementRoutes.revokeDevice(buildingIds, revokeMatch[1]), requestOrigin);
      }
      const reprovisionMatch = path.match(/^\/api\/management\/devices\/([^/]+)\/reprovision$/);
      if (reprovisionMatch && method === 'POST') {
        return json(200, await managementRoutes.reprovisionDevice(buildingIds, reprovisionMatch[1]), requestOrigin);
      }

      // --- Notifications ---
      if (method === 'GET' && path === '/api/management/notifications') {
        return json(200, await managementRoutes.listNotifications(buildingIds), requestOrigin);
      }
      if (method === 'POST' && path === '/api/management/notifications') {
        return json(200, await managementRoutes.createNotification(buildingIds, body), requestOrigin);
      }
      const notifMatch = path.match(/^\/api\/management\/notifications\/([^/]+)$/);
      if (notifMatch && method === 'DELETE') {
        return json(200, await managementRoutes.deleteNotification(buildingIds, notifMatch[1]), requestOrigin);
      }

      // --- Audit Logs ---
      if (method === 'GET' && path === '/api/management/audit-logs') {
        return json(200, await managementRoutes.listAuditLogs(buildingIds, queryParams), requestOrigin);
      }

      // --- Delivery Health ---
      if (method === 'GET' && path === '/api/management/delivery-health') {
        return json(200, await managementRoutes.getDeliveryHealth(buildingIds, queryParams), requestOrigin);
      }

      return json(404, { error: 'Not found' }, requestOrigin);
    }

    return json(404, { error: 'Not found' }, requestOrigin);
  } catch (err) {
    console.error(`[LAMBDA] Error handling ${method} ${path}:`, summarizeError(err));
    return json(500, { error: 'Internal server error' }, requestOrigin);
  }
};
