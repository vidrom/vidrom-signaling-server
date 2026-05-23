const test = require('node:test');
const assert = require('node:assert/strict');

const { requireWithMocks } = require('./wsTestHarness');

const ORIGINAL_ENV = {
  PORTAL_RATE_LIMIT_AUTH_MAX: process.env.PORTAL_RATE_LIMIT_AUTH_MAX,
  PORTAL_RATE_LIMIT_AUTH_WINDOW_MS: process.env.PORTAL_RATE_LIMIT_AUTH_WINDOW_MS,
  PORTAL_RATE_LIMIT_MUTATION_MAX: process.env.PORTAL_RATE_LIMIT_MUTATION_MAX,
  PORTAL_RATE_LIMIT_MUTATION_WINDOW_MS: process.env.PORTAL_RATE_LIMIT_MUTATION_WINDOW_MS,
  PORTAL_RATE_LIMIT_PROVISIONING_MAX: process.env.PORTAL_RATE_LIMIT_PROVISIONING_MAX,
  PORTAL_RATE_LIMIT_PROVISIONING_WINDOW_MS: process.env.PORTAL_RATE_LIMIT_PROVISIONING_WINDOW_MS,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function loadHandler({
  verifyAdminTokenImpl,
  verifyManagementTokenImpl,
  adminRoutes = {},
  managementRoutes = {},
} = {}) {
  delete require.cache[require.resolve('../lambda/rateLimit')];
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
        return [{ id: 'building-1', name: 'HQ' }];
      },
      async reprovisionDevice(deviceId) {
        return { id: deviceId, provisioning_code: '123456' };
      },
      ...adminRoutes,
    },
    './managementRoutes': {
      async listBuildings() {
        return [{ id: 'building-2', name: 'Managed Building' }];
      },
      ...managementRoutes,
    },
  });
}

function createEvent({
  method = 'GET',
  path = '/api/admin/buildings',
  origin = 'https://portal.vidrom.com',
  authorization,
  forwardedFor = '203.0.113.10, 70.1.1.1',
} = {}) {
  const headers = {
    origin,
    'x-forwarded-for': forwardedFor,
  };
  if (authorization) headers.authorization = authorization;

  return {
    requestContext: { http: { method, sourceIp: '198.51.100.20' } },
    rawPath: path,
    queryStringParameters: null,
    headers,
    body: null,
    isBase64Encoded: false,
  };
}

test.afterEach(() => {
  restoreEnv();
});

test('portal API rate limits repeated unauthorized requests by client IP', async () => {
  process.env.PORTAL_RATE_LIMIT_AUTH_MAX = '2';
  process.env.PORTAL_RATE_LIMIT_AUTH_WINDOW_MS = '60000';

  const { handler } = loadHandler();

  const event = createEvent({ path: '/api/management/buildings' });

  const first = await handler(event);
  const second = await handler(event);
  const third = await handler(event);

  assert.equal(first.statusCode, 401);
  assert.equal(second.statusCode, 401);
  assert.equal(third.statusCode, 429);
  assert.equal(third.headers['Retry-After'], '60');
  assert.equal(third.headers['Access-Control-Allow-Origin'], 'https://portal.vidrom.com');
});

test('portal API rate limits repeated provisioning actions by authenticated operator', async () => {
  process.env.PORTAL_RATE_LIMIT_AUTH_MAX = '10';
  process.env.PORTAL_RATE_LIMIT_PROVISIONING_MAX = '1';
  process.env.PORTAL_RATE_LIMIT_PROVISIONING_WINDOW_MS = '60000';

  let reprovisionCalls = 0;
  const { handler } = loadHandler({
    verifyAdminTokenImpl() {
      return { email: 'admin@example.com', userId: 'admin-1' };
    },
    adminRoutes: {
      async reprovisionDevice(deviceId) {
        reprovisionCalls += 1;
        return { id: deviceId, provisioning_code: '654321' };
      },
    },
  });

  const event = createEvent({
    method: 'POST',
    path: '/api/admin/devices/device-1/reprovision',
    authorization: 'Bearer token',
  });

  const first = await handler(event);
  const second = await handler(event);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 429);
  assert.equal(second.headers['Retry-After'], '60');
  assert.equal(second.headers['X-RateLimit-Limit'], '1');
  assert.equal(reprovisionCalls, 1);
});