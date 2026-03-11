// Lambda entry point — routes API Gateway events to admin/management handlers
const { verifyAdminToken, verifyManagementToken } = require('./adminAuth');
const adminRoutes = require('./adminRoutes');
const managementRoutes = require('./managementRoutes');

// CORS headers included in every response
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(statusCode, data) {
  if (data && data.status && data.error) {
    statusCode = data.status;
    data = { error: data.error };
  }
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(data),
  };
}

exports.handler = async (event) => {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const queryParams = event.queryStringParameters || {};

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS };
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
      return json(400, { error: 'Invalid JSON body' });
    }
  }

  try {
    // ═══════════════════════════════════════════════════════════
    // Admin API routes (/api/admin/*)
    // ═══════════════════════════════════════════════════════════
    if (path.startsWith('/api/admin/')) {
      const adminUser = await verifyAdminToken(req);
      if (!adminUser) return json(401, { error: 'Unauthorized' });
      console.log(`[ADMIN] ${method} ${path} — ${adminUser.email}`);

      // --- Buildings ---
      if (method === 'GET' && path === '/api/admin/buildings') {
        return json(200, await adminRoutes.listBuildings());
      }
      if (method === 'POST' && path === '/api/admin/buildings') {
        return json(200, await adminRoutes.createBuilding(body));
      }
      const buildingMatch = path.match(/^\/api\/admin\/buildings\/([^/]+)$/);
      if (buildingMatch && method === 'PUT') {
        return json(200, await adminRoutes.updateBuilding(buildingMatch[1], body));
      }
      if (buildingMatch && method === 'DELETE') {
        return json(200, await adminRoutes.deleteBuilding(buildingMatch[1]));
      }

      // --- Apartments under building ---
      const bldgAptMatch = path.match(/^\/api\/admin\/buildings\/([^/]+)\/apartments$/);
      if (bldgAptMatch && method === 'GET') {
        return json(200, await adminRoutes.listApartments(bldgAptMatch[1]));
      }
      if (bldgAptMatch && method === 'POST') {
        return json(200, await adminRoutes.createApartment(bldgAptMatch[1], body));
      }

      // --- Apartments direct ---
      const aptMatch = path.match(/^\/api\/admin\/apartments\/([^/]+)$/);
      if (aptMatch && method === 'PUT') {
        return json(200, await adminRoutes.updateApartment(aptMatch[1], body));
      }
      if (aptMatch && method === 'DELETE') {
        return json(200, await adminRoutes.deleteApartment(aptMatch[1]));
      }

      // --- Users ---
      if (method === 'GET' && path === '/api/admin/users') {
        return json(200, await adminRoutes.listUsers());
      }
      if (method === 'POST' && path === '/api/admin/users') {
        return json(200, await adminRoutes.createUser(body));
      }
      const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (userMatch && method === 'PUT') {
        return json(200, await adminRoutes.updateUser(userMatch[1], body));
      }
      if (userMatch && method === 'DELETE') {
        return json(200, await adminRoutes.deleteUser(userMatch[1]));
      }

      // --- Building Managers ---
      const bldgMgrMatch = path.match(/^\/api\/admin\/buildings\/([^/]+)\/managers$/);
      if (bldgMgrMatch && method === 'GET') {
        return json(200, await adminRoutes.listBuildingManagers(bldgMgrMatch[1]));
      }
      if (bldgMgrMatch && method === 'POST') {
        return json(200, await adminRoutes.assignManager(bldgMgrMatch[1], body));
      }
      const removeMgrMatch = path.match(/^\/api\/admin\/buildings\/([^/]+)\/managers\/([^/]+)$/);
      if (removeMgrMatch && method === 'DELETE') {
        return json(200, await adminRoutes.removeManager(removeMgrMatch[1], removeMgrMatch[2]));
      }

      // --- Apartment Residents ---
      const aptResMatch = path.match(/^\/api\/admin\/apartments\/([^/]+)\/residents$/);
      if (aptResMatch && method === 'GET') {
        return json(200, await adminRoutes.listApartmentResidents(aptResMatch[1]));
      }
      if (aptResMatch && method === 'POST') {
        return json(200, await adminRoutes.assignResident(aptResMatch[1], body));
      }
      const removeResMatch = path.match(/^\/api\/admin\/apartments\/([^/]+)\/residents\/([^/]+)$/);
      if (removeResMatch && method === 'DELETE') {
        return json(200, await adminRoutes.removeResident(removeResMatch[1], removeResMatch[2]));
      }

      // --- Devices (Intercoms) ---
      if (method === 'GET' && path === '/api/admin/devices') {
        return json(200, await adminRoutes.listDevices());
      }
      if (method === 'POST' && path === '/api/admin/devices') {
        return json(200, await adminRoutes.createDevice(body));
      }
      const devMatch = path.match(/^\/api\/admin\/devices\/([^/]+)$/);
      if (devMatch && method === 'PUT') {
        return json(200, await adminRoutes.updateDevice(devMatch[1], body));
      }
      if (devMatch && method === 'DELETE') {
        return json(200, await adminRoutes.deleteDevice(devMatch[1]));
      }
      const revokeMatch = path.match(/^\/api\/admin\/devices\/([^/]+)\/revoke$/);
      if (revokeMatch && method === 'POST') {
        return json(200, await adminRoutes.revokeDevice(revokeMatch[1]));
      }
      const reprovisionMatch = path.match(/^\/api\/admin\/devices\/([^/]+)\/reprovision$/);
      if (reprovisionMatch && method === 'POST') {
        return json(200, await adminRoutes.reprovisionDevice(reprovisionMatch[1]));
      }

      // --- Notifications ---
      if (method === 'GET' && path === '/api/admin/notifications') {
        return json(200, await adminRoutes.listNotifications());
      }
      if (method === 'POST' && path === '/api/admin/notifications') {
        return json(200, await adminRoutes.createNotification(body));
      }
      const notifMatch = path.match(/^\/api\/admin\/notifications\/([^/]+)$/);
      if (notifMatch && method === 'DELETE') {
        return json(200, await adminRoutes.deleteNotification(notifMatch[1]));
      }

      // --- Audit Logs ---
      if (method === 'GET' && path === '/api/admin/audit-logs') {
        return json(200, await adminRoutes.listAuditLogs(queryParams));
      }

      // --- Global Settings ---
      if (method === 'GET' && path === '/api/admin/settings') {
        return json(200, await adminRoutes.listSettings());
      }
      const settingMatch = path.match(/^\/api\/admin\/settings\/([^/]+)$/);
      if (settingMatch && method === 'PUT') {
        return json(200, await adminRoutes.updateSetting(decodeURIComponent(settingMatch[1]), body));
      }

      return json(404, { error: 'Not found' });
    }

    // ═══════════════════════════════════════════════════════════
    // Management API routes (/api/management/*)
    // ═══════════════════════════════════════════════════════════
    if (path.startsWith('/api/management/')) {
      const mgmtUser = await verifyManagementToken(req);
      if (!mgmtUser) return json(401, { error: 'Unauthorized' });
      console.log(`[MGMT] ${method} ${path} — ${mgmtUser.email} (buildings: ${mgmtUser.buildingIds.length})`);
      const buildingIds = mgmtUser.buildingIds;

      // --- Buildings ---
      if (method === 'GET' && path === '/api/management/buildings') {
        return json(200, await managementRoutes.listBuildings(buildingIds));
      }
      const bldgMatch = path.match(/^\/api\/management\/buildings\/([^/]+)$/);
      if (bldgMatch && method === 'PUT') {
        return json(200, await managementRoutes.updateBuilding(buildingIds, bldgMatch[1], body));
      }

      // --- Apartments ---
      const bldgAptMatch = path.match(/^\/api\/management\/buildings\/([^/]+)\/apartments$/);
      if (bldgAptMatch && method === 'GET') {
        return json(200, await managementRoutes.listApartments(buildingIds, bldgAptMatch[1]));
      }
      if (bldgAptMatch && method === 'POST') {
        return json(200, await managementRoutes.createApartment(buildingIds, bldgAptMatch[1], body));
      }
      const aptMatch = path.match(/^\/api\/management\/apartments\/([^/]+)$/);
      if (aptMatch && method === 'PUT') {
        return json(200, await managementRoutes.updateApartment(buildingIds, aptMatch[1], body));
      }
      if (aptMatch && method === 'DELETE') {
        return json(200, await managementRoutes.deleteApartment(buildingIds, aptMatch[1]));
      }

      // --- Residents ---
      const aptResMatch = path.match(/^\/api\/management\/apartments\/([^/]+)\/residents$/);
      if (aptResMatch && method === 'GET') {
        return json(200, await managementRoutes.listResidents(buildingIds, aptResMatch[1]));
      }
      if (aptResMatch && method === 'POST') {
        return json(200, await managementRoutes.assignResident(buildingIds, aptResMatch[1], body));
      }
      const removeResMatch = path.match(/^\/api\/management\/apartments\/([^/]+)\/residents\/([^/]+)$/);
      if (removeResMatch && method === 'DELETE') {
        return json(200, await managementRoutes.removeResident(buildingIds, removeResMatch[1], removeResMatch[2]));
      }

      // --- Devices ---
      if (method === 'GET' && path === '/api/management/devices') {
        return json(200, await managementRoutes.listDevices(buildingIds));
      }
      if (method === 'POST' && path === '/api/management/devices') {
        return json(200, await managementRoutes.createDevice(buildingIds, body));
      }
      const revokeMatch = path.match(/^\/api\/management\/devices\/([^/]+)\/revoke$/);
      if (revokeMatch && method === 'POST') {
        return json(200, await managementRoutes.revokeDevice(buildingIds, revokeMatch[1]));
      }
      const reprovisionMatch = path.match(/^\/api\/management\/devices\/([^/]+)\/reprovision$/);
      if (reprovisionMatch && method === 'POST') {
        return json(200, await managementRoutes.reprovisionDevice(buildingIds, reprovisionMatch[1]));
      }

      // --- Notifications ---
      if (method === 'GET' && path === '/api/management/notifications') {
        return json(200, await managementRoutes.listNotifications(buildingIds));
      }
      if (method === 'POST' && path === '/api/management/notifications') {
        return json(200, await managementRoutes.createNotification(buildingIds, body));
      }
      const notifMatch = path.match(/^\/api\/management\/notifications\/([^/]+)$/);
      if (notifMatch && method === 'DELETE') {
        return json(200, await managementRoutes.deleteNotification(buildingIds, notifMatch[1]));
      }

      // --- Audit Logs ---
      if (method === 'GET' && path === '/api/management/audit-logs') {
        return json(200, await managementRoutes.listAuditLogs(buildingIds, queryParams));
      }

      return json(404, { error: 'Not found' });
    }

    return json(404, { error: 'Not found' });
  } catch (err) {
    console.error(`[LAMBDA] Error handling ${method} ${path}:`, err);
    return json(500, { error: 'Internal server error' });
  }
};
