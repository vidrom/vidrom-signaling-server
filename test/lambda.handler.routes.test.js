const test = require('node:test');
const assert = require('node:assert/strict');

const { requireWithMocks } = require('./wsTestHarness');

function loadHandler({
  verifyAdminTokenImpl,
  verifyManagementTokenImpl,
  adminRoutes = {},
  managementRoutes = {},
} = {}) {
  delete require.cache[require.resolve('../lambda/handler')];

  return requireWithMocks('../lambda/handler', {
    './adminAuth': {
      async verifyAdminToken(req) {
        return verifyAdminTokenImpl ? verifyAdminTokenImpl(req) : null;
      },
      async verifyManagementToken(req) {
        return verifyManagementTokenImpl ? verifyManagementTokenImpl(req) : null;
      },
    },
    './adminRoutes': {
      async listBuildings() {
        return [];
      },
      ...adminRoutes,
    },
    './managementRoutes': {
      async listBuildings() {
        return [];
      },
      ...managementRoutes,
    },
  });
}

function createEvent({
  method = 'GET',
  path = '/api/admin/buildings',
  origin = 'https://portal.vidrom.com',
  authorization = 'Bearer token',
  queryStringParameters = null,
  body = null,
  isBase64Encoded = false,
} = {}) {
  const headers = { origin };
  if (authorization) headers.authorization = authorization;

  return {
    requestContext: { http: { method }, sourceIp: '198.51.100.20' },
    rawPath: path,
    queryStringParameters,
    headers,
    body,
    isBase64Encoded,
  };
}

test('lambda handler forwards decoded admin setting keys and parsed JSON bodies', async () => {
  let receivedKey = null;
  let receivedBody = null;

  const { handler } = loadHandler({
    verifyAdminTokenImpl() {
      return { email: 'admin@example.com', userId: 'admin-1' };
    },
    adminRoutes: {
      async updateSetting(key, body) {
        receivedKey = key;
        receivedBody = body;
        return { key, value: body.value };
      },
    },
  });

  const response = await handler(createEvent({
    method: 'PUT',
    path: '/api/admin/settings/max_call_duration',
    body: JSON.stringify({ value: '75' }),
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(receivedKey, 'max_call_duration');
  assert.deepEqual(receivedBody, { value: '75' });
  assert.deepEqual(JSON.parse(response.body), {
    key: 'max_call_duration',
    value: '75',
  });
});

test('lambda handler forwards management delivery-health query parameters and building scope', async () => {
  let receivedBuildingIds = null;
  let receivedQueryParams = null;

  const { handler } = loadHandler({
    verifyManagementTokenImpl() {
      return {
        email: 'manager@example.com',
        userId: 'manager-1',
        buildingIds: ['building-1', 'building-2'],
      };
    },
    managementRoutes: {
      async getDeliveryHealth(buildingIds, queryParams) {
        receivedBuildingIds = buildingIds;
        receivedQueryParams = queryParams;
        return { ok: true, buildingIds, queryParams };
      },
    },
  });

  const response = await handler(createEvent({
    path: '/api/management/delivery-health',
    queryStringParameters: {
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-18T00:00:00.000Z',
    },
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(receivedBuildingIds, ['building-1', 'building-2']);
  assert.deepEqual(receivedQueryParams, {
    from: '2026-06-01T00:00:00.000Z',
    to: '2026-06-18T00:00:00.000Z',
  });
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    buildingIds: ['building-1', 'building-2'],
    queryParams: {
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-18T00:00:00.000Z',
    },
  });
});

test('lambda handler forwards management device creation bodies with assigned building scope', async () => {
  let receivedBuildingIds = null;
  let receivedBody = null;

  const { handler } = loadHandler({
    verifyManagementTokenImpl() {
      return {
        email: 'manager@example.com',
        userId: 'manager-1',
        buildingIds: ['building-1'],
      };
    },
    managementRoutes: {
      async createDevice(buildingIds, body) {
        receivedBuildingIds = buildingIds;
        receivedBody = body;
        return { id: 'device-1', ...body, provisioning_code: '123456' };
      },
    },
  });

  const response = await handler(createEvent({
    method: 'POST',
    path: '/api/management/devices',
    body: JSON.stringify({
      building_id: 'building-1',
      name: 'Lobby Intercom',
      gate_id: 'gate-1',
    }),
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(receivedBuildingIds, ['building-1']);
  assert.deepEqual(receivedBody, {
    building_id: 'building-1',
    name: 'Lobby Intercom',
    gate_id: 'gate-1',
  });
  assert.deepEqual(JSON.parse(response.body), {
    id: 'device-1',
    building_id: 'building-1',
    name: 'Lobby Intercom',
    gate_id: 'gate-1',
    provisioning_code: '123456',
  });
});

test('lambda handler decodes base64 JSON bodies before admin route dispatch', async () => {
  let receivedBody = null;

  const { handler } = loadHandler({
    verifyAdminTokenImpl() {
      return { email: 'admin@example.com', userId: 'admin-1' };
    },
    adminRoutes: {
      async createNotification(body) {
        receivedBody = body;
        return { id: 'notification-1', ...body };
      },
    },
  });

  const encodedBody = Buffer.from(JSON.stringify({
    building_id: 'building-1',
    text: 'Encoded maintenance notice',
  })).toString('base64');

  const response = await handler(createEvent({
    method: 'POST',
    path: '/api/admin/notifications',
    body: encodedBody,
    isBase64Encoded: true,
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(receivedBody, {
    building_id: 'building-1',
    text: 'Encoded maintenance notice',
  });
  assert.deepEqual(JSON.parse(response.body), {
    id: 'notification-1',
    building_id: 'building-1',
    text: 'Encoded maintenance notice',
  });
});

test('lambda handler maps route error objects to HTTP status codes', async () => {
  const { handler } = loadHandler({
    verifyAdminTokenImpl() {
      return { email: 'admin@example.com', userId: 'admin-1' };
    },
    adminRoutes: {
      async updateBuilding() {
        return {
          error: 'Building not found',
          status: 404,
        };
      },
    },
  });

  const response = await handler(createEvent({
    method: 'PUT',
    path: '/api/admin/buildings/building-404',
    body: JSON.stringify({ name: 'Updated' }),
  }));

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), {
    error: 'Building not found',
  });
});

test('lambda handler forwards building path params to management device-health routes', async () => {
  let receivedBuildingIds = null;
  let receivedBuildingId = null;

  const { handler } = loadHandler({
    verifyManagementTokenImpl() {
      return {
        email: 'manager@example.com',
        userId: 'manager-1',
        buildingIds: ['building-1', 'building-2'],
      };
    },
    managementRoutes: {
      async getDeviceHealth(buildingIds, buildingId) {
        receivedBuildingIds = buildingIds;
        receivedBuildingId = buildingId;
        return [{ apartment_id: 'apt-1', apartment_health: 'ok' }];
      },
    },
  });

  const response = await handler(createEvent({
    path: '/api/management/buildings/building-2/device-health',
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(receivedBuildingIds, ['building-1', 'building-2']);
  assert.equal(receivedBuildingId, 'building-2');
  assert.deepEqual(JSON.parse(response.body), [
    {
      apartment_id: 'apt-1',
      apartment_health: 'ok',
    },
  ]);
});

test('lambda handler rejects invalid JSON bodies before route dispatch', async () => {
  let routeCalled = false;

  const { handler } = loadHandler({
    verifyAdminTokenImpl() {
      return { email: 'admin@example.com', userId: 'admin-1' };
    },
    adminRoutes: {
      async createBuilding() {
        routeCalled = true;
        return { id: 'building-1' };
      },
    },
  });

  const response = await handler(createEvent({
    method: 'POST',
    path: '/api/admin/buildings',
    body: '{bad json',
  }));

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'Invalid JSON body' });
  assert.equal(routeCalled, false);
});

test('lambda handler returns 404 for unknown admin and management routes after successful auth', async () => {
  const { handler } = loadHandler({
    verifyAdminTokenImpl() {
      return { email: 'admin@example.com', userId: 'admin-1' };
    },
    verifyManagementTokenImpl() {
      return {
        email: 'manager@example.com',
        userId: 'manager-1',
        buildingIds: ['building-1'],
      };
    },
  });

  const adminResponse = await handler(createEvent({
    path: '/api/admin/unknown-route',
  }));
  const managementResponse = await handler(createEvent({
    path: '/api/management/unknown-route',
  }));

  assert.equal(adminResponse.statusCode, 404);
  assert.deepEqual(JSON.parse(adminResponse.body), { error: 'Not found' });
  assert.equal(managementResponse.statusCode, 404);
  assert.deepEqual(JSON.parse(managementResponse.body), { error: 'Not found' });
});

test('lambda handler converts thrown route errors into 500 responses', async () => {
  const { handler } = loadHandler({
    verifyAdminTokenImpl() {
      return { email: 'admin@example.com', userId: 'admin-1' };
    },
    adminRoutes: {
      async listBuildings() {
        throw new Error('database offline');
      },
    },
  });

  const response = await handler(createEvent({ path: '/api/admin/buildings' }));

  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), { error: 'Internal server error' });
});