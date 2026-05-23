const test = require('node:test');
const assert = require('node:assert/strict');

const { requireWithMocks } = require('./wsTestHarness');

function loadHandler({ verifyAdminTokenImpl, verifyManagementTokenImpl } = {}) {
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
    },
    './managementRoutes': {
      async listBuildings() {
        return [{ id: 'building-2', name: 'Managed Building' }];
      },
    },
  });
}

function createEvent({
  method = 'GET',
  path = '/api/admin/buildings',
  origin,
  authorization,
} = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  if (authorization) headers.authorization = authorization;

  return {
    requestContext: { http: { method } },
    rawPath: path,
    queryStringParameters: null,
    headers,
    body: null,
    isBase64Encoded: false,
  };
}

test('portal API reflects the allowed portal origin and sends security headers', async () => {
  const { handler } = loadHandler({
    verifyAdminTokenImpl() {
      return { email: 'admin@example.com', userId: 'admin-1' };
    },
  });

  const response = await handler(createEvent({
    origin: 'https://portal.vidrom.com',
    authorization: 'Bearer token',
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://portal.vidrom.com');
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(response.headers['X-Frame-Options'], 'DENY');
  assert.equal(response.headers['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains; preload');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.match(response.headers['Content-Security-Policy'], /default-src 'none'/);
  assert.equal(response.headers.Vary, 'Origin');
});

test('portal API does not grant CORS to unknown origins', async () => {
  const { handler } = loadHandler({
    verifyAdminTokenImpl() {
      return { email: 'admin@example.com', userId: 'admin-1' };
    },
  });

  const response = await handler(createEvent({
    origin: 'https://evil.example.com',
    authorization: 'Bearer token',
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(response.headers.Vary, 'Origin');
});

test('portal API preflight keeps allowed origin restricted to the configured portal host', async () => {
  const { handler } = loadHandler();

  const response = await handler(createEvent({
    method: 'OPTIONS',
    path: '/api/management/buildings',
    origin: 'https://portal.vidrom.com',
  }));

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://portal.vidrom.com');
  assert.equal(response.headers['Access-Control-Allow-Methods'], 'GET, POST, PUT, DELETE, OPTIONS');
});

test('portal API returns security headers even on unauthorized responses', async () => {
  const { handler } = loadHandler({
    verifyManagementTokenImpl() {
      return null;
    },
  });

  const response = await handler(createEvent({
    path: '/api/management/buildings',
    origin: 'https://portal.vidrom.com',
  }));

  assert.equal(response.statusCode, 401);
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://portal.vidrom.com');
  assert.equal(response.headers['Cache-Control'], 'no-store');
});