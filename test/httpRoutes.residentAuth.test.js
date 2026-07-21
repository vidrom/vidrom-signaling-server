const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { hashDoorCode } = require('../src/doorCode');
const { requireWithMocks } = require('./wsTestHarness');

function createRequest({ method = 'GET', url = '/', headers = {}, body, rawBody } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;

  process.nextTick(() => {
    if (rawBody !== undefined) {
      req.emit('data', Buffer.from(rawBody));
      req.emit('end');
      return;
    }
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)));
    }
    req.emit('end');
  });

  return req;
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      Object.assign(this.headers, headers);
    },
    end(payload = '') {
      this.body = payload;
    },
  };
}

function createHandleRequestHarness({ queryImpl, residentContext, adminContext } = {}) {
  const queryCalls = [];
  const httpAcceptCalls = [];

  const { handleRequest } = requireWithMocks('../src/httpRoutes', {
    './auth': {
      generateDeviceToken() {
        return 'device-token';
      },
      verifyToken() {
        return { deviceId: 'intercom-1', buildingId: 'building-1', role: 'intercom' };
      },
      async authenticateAdminRequest() {
        if (!adminContext) {
          const err = new Error('Unauthorized');
          err.status = 401;
          err.expose = true;
          throw err;
        }
        return adminContext;
      },
      async authenticateResidentRequest() {
        if (!residentContext) {
          const err = new Error('Unauthorized');
          err.status = 401;
          err.expose = true;
          throw err;
        }
        return residentContext;
      },
      residentHasApartmentAccess(context, apartmentId) {
        return context.apartmentIds.includes(apartmentId);
      },
    },
    './connectionState': {
      clients: { intercom: null, home: null },
      fcmTokens: new Map(),
      voipTokens: new Map(),
      activeCalls: new Map(),
      intercoms: new Map(),
      getIntercom() {
        return null;
      },
      getHomeClients() {
        return new Map();
      },
      clearPendingRing() {},
      sendToApartment() {},
      startAcceptTimer() {},
      activeCall: {
        getByApartment() {
          return null;
        },
        httpAccept(intercomId, userId) {
          httpAcceptCalls.push({ intercomId, userId });
          return true;
        },
        get() {
          return null;
        },
      },
    },
    './apnsService': {
      isAPNsReady() {
        return false;
      },
      async sendVoipPush() {},
    },
    './db': {
      async query(sql, params = []) {
        queryCalls.push({ sql, params });
        return queryImpl(sql, params);
      },
    },
    './retryOrchestrator': {
      cancelRetries() {},
    },
    './deviceHealthScore': {
      computeDeviceHealth() {
        return { health_score: 100, health_status: 'healthy' };
      },
    },
    './startupConfig': {
      buildRtcConfig() {
        return { iceServers: [] };
      },
    },
    'firebase-admin': {
      messaging() {
        return { async send() {} };
      },
    },
  });

  return { handleRequest, queryCalls, httpAcceptCalls };
}

test('healthz is public and minimal', async () => {
  const harness = createHandleRequestHarness({
    queryImpl() {
      throw new Error('query should not run');
    },
  });

  const req = createRequest({ method: 'GET', url: '/healthz' });
  const res = createResponse();

  await harness.handleRequest(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

test('debug status requires admin auth', async () => {
  const harness = createHandleRequestHarness({
    queryImpl() {
      throw new Error('query should not run');
    },
  });

  const req = createRequest({ method: 'GET', url: '/debug/status' });
  const res = createResponse();

  await harness.handleRequest(req, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' });
});

test('rtc config requires resident auth for home clients', async () => {
  const harness = createHandleRequestHarness({
    queryImpl() {
      throw new Error('query should not run');
    },
    residentContext: null,
  });

  const req = createRequest({ method: 'GET', url: '/api/rtc-config' });
  const res = createResponse();

  await harness.handleRequest(req, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' });
});

test('intercom door-code verification never discloses expected code', async () => {
  const harness = createHandleRequestHarness({
    queryImpl(sql) {
      if (sql.includes('SELECT door_code, door_code_hash FROM intercoms')) {
        return { rows: [{ door_code: '123456', door_code_hash: null }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const req = createRequest({
    method: 'POST',
    url: '/api/intercom/verify-door-code',
    headers: { authorization: 'Bearer device-token' },
    body: { code: '000000' },
  });
  const res = createResponse();

  await harness.handleRequest(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { valid: false });
});

test('intercom door-code verification uses cached hash without repeated DB lookup', async () => {
  const storedHash = hashDoorCode('123456', { iterations: 1, salt: 'door-cache-test' });
  let selectCount = 0;
  const harness = createHandleRequestHarness({
    queryImpl(sql) {
      if (sql.includes('SELECT door_code, door_code_hash FROM intercoms')) {
        selectCount += 1;
        return { rows: [{ door_code: null, door_code_hash: storedHash }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const firstReq = createRequest({
    method: 'POST',
    url: '/api/intercom/verify-door-code',
    headers: { authorization: 'Bearer device-token' },
    body: { code: '123456' },
  });
  const firstRes = createResponse();
  await harness.handleRequest(firstReq, firstRes);

  const secondReq = createRequest({
    method: 'POST',
    url: '/api/intercom/verify-door-code',
    headers: { authorization: 'Bearer device-token' },
    body: { code: '123456' },
  });
  const secondRes = createResponse();
  await harness.handleRequest(secondReq, secondRes);

  assert.equal(firstRes.statusCode, 200);
  assert.deepEqual(JSON.parse(firstRes.body), { valid: true });
  assert.equal(secondRes.statusCode, 200);
  assert.deepEqual(JSON.parse(secondRes.body), { valid: true });
  assert.equal(selectCount, 1);
});

test('intercom door-code cached verifier still rejects wrong codes', async () => {
  const storedHash = hashDoorCode('123456', { iterations: 1, salt: 'door-cache-wrong-test' });
  let selectCount = 0;
  const harness = createHandleRequestHarness({
    queryImpl(sql) {
      if (sql.includes('SELECT door_code, door_code_hash FROM intercoms')) {
        selectCount += 1;
        return { rows: [{ door_code: null, door_code_hash: storedHash }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const warmReq = createRequest({
    method: 'POST',
    url: '/api/intercom/verify-door-code',
    headers: { authorization: 'Bearer device-token' },
    body: { code: '123456' },
  });
  const warmRes = createResponse();
  await harness.handleRequest(warmReq, warmRes);

  const fallbackReq = createRequest({
    method: 'POST',
    url: '/api/intercom/verify-door-code',
    headers: { authorization: 'Bearer device-token' },
    body: { code: '000000' },
  });
  const fallbackRes = createResponse();
  await harness.handleRequest(fallbackReq, fallbackRes);

  assert.equal(warmRes.statusCode, 200);
  assert.deepEqual(JSON.parse(warmRes.body), { valid: true });
  assert.equal(fallbackRes.statusCode, 200);
  assert.deepEqual(JSON.parse(fallbackRes.body), { valid: false });
  assert.equal(selectCount, 1);
});

test('oversized JSON body is rejected before route handling', async () => {
  const harness = createHandleRequestHarness({
    queryImpl() {
      throw new Error('query should not run');
    },
  });

  const req = createRequest({
    method: 'POST',
    url: '/api/client-error',
    rawBody: JSON.stringify({ app: 'home', error_type: 'x', message: 'a'.repeat(40000) }),
  });
  const res = createResponse();

  await harness.handleRequest(req, res);

  assert.equal(res.statusCode, 413);
  assert.deepEqual(JSON.parse(res.body), { error: 'Request body too large' });
});

test('client-debug-event inserts a structured debug entry', async () => {
  const harness = createHandleRequestHarness({
    queryImpl(sql, params) {
      assert.match(sql, /INSERT INTO client_errors/);
      assert.equal(params[0], 'intercom');
      assert.equal(params[1], 'debug:ws-connected');
      assert.equal(params[2], 'ws-connected');
      assert.equal(params[4], '{"hasDeviceToken":true}');
      return { rows: [] };
    },
  });

  const req = createRequest({
    method: 'POST',
    url: '/api/client-debug-event',
    body: {
      app: 'intercom',
      event_type: 'ws-connected',
      context: { hasDeviceToken: true },
    },
  });
  const res = createResponse();

  await harness.handleRequest(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

test('resolve-apartment returns 401 without resident bearer auth', async () => {
  const harness = createHandleRequestHarness({
    queryImpl() {
      throw new Error('query should not run');
    },
    residentContext: null,
  });

  const req = createRequest({ method: 'POST', url: '/api/home/resolve-apartment', body: {} });
  const res = createResponse();

  await harness.handleRequest(req, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' });
});

test('register-voip-token returns 401 without resident bearer auth', async () => {
  const harness = createHandleRequestHarness({
    queryImpl() {
      throw new Error('query should not run');
    },
    residentContext: null,
  });

  const req = createRequest({ method: 'POST', url: '/register-voip-token', body: { token: 'voip-token' } });
  const res = createResponse();

  await harness.handleRequest(req, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' });
});

test('resolve-apartment ignores spoofed email and returns authenticated resident apartment', async () => {
  const harness = createHandleRequestHarness({
    residentContext: {
      userId: 'user-1',
      userName: 'Resident One',
      apartmentIds: ['apt-1'],
      primaryApartmentId: 'apt-1',
      primaryApartment: {
        apartmentId: 'apt-1',
        apartmentNumber: '12A',
        apartmentName: 'Unit 12A',
        buildingId: 'building-1',
      },
    },
    queryImpl(sql) {
      if (sql.includes('FROM buildings')) {
        return { rows: [{ building_name: 'Vidrom Towers', building_address: '1 Main St' }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const req = createRequest({
    method: 'POST',
    url: '/api/home/resolve-apartment',
    headers: { authorization: 'Bearer resident-token' },
    body: { email: 'spoof@example.com' },
  });
  const res = createResponse();

  await harness.handleRequest(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    userId: 'user-1',
    userName: 'Resident One',
    apartmentId: 'apt-1',
    apartmentNumber: '12A',
    apartmentName: 'Unit 12A',
    buildingId: 'building-1',
    buildingName: 'Vidrom Towers',
    buildingAddress: '1 Main St',
    apartmentIds: ['apt-1'],
    primaryApartmentId: 'apt-1',
  });
});

test('register-fcm-token stores server-derived resident ownership', async () => {
  const harness = createHandleRequestHarness({
    residentContext: {
      userId: 'user-1',
      apartmentIds: ['apt-1'],
      primaryApartmentId: 'apt-1',
      primaryApartment: { apartmentId: 'apt-1', buildingId: 'building-1' },
    },
    queryImpl(sql) {
      if (sql.includes('SELECT * FROM device_health')) return { rows: [] };
      if (sql.includes('SELECT 1 FROM call_delivery_acks')) return { rows: [] };
      if (sql.includes('INSERT INTO device_health')) return { rows: [] };
      if (sql.includes('INSERT INTO device_tokens')) return { rows: [] };
      if (sql.includes('DELETE FROM device_tokens')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const req = createRequest({
    method: 'POST',
    url: '/register-fcm-token',
    headers: { authorization: 'Bearer resident-token' },
    body: { token: 'fcm-token', apartmentId: 'spoof-apt', userId: 'spoof-user', platform: 'ios' },
  });
  const res = createResponse();

  await harness.handleRequest(req, res);

  assert.equal(res.statusCode, 200);
  const insertCall = harness.queryCalls.find(({ sql }) => sql.includes('INSERT INTO device_tokens'));
  assert.deepEqual(insertCall.params, ['apt-1', 'user-1', 'fcm-token', 'ios']);
  const deleteCall = harness.queryCalls.find(({ sql }) => sql.includes('DELETE FROM device_tokens'));
  assert.deepEqual(deleteCall.params, ['user-1', 'fcm-token']);
});

test('register-fcm-token cannot delete another resident token rows', async () => {
  const harness = createHandleRequestHarness({
    residentContext: {
      userId: 'user-1',
      apartmentIds: ['apt-1'],
      primaryApartmentId: 'apt-1',
      primaryApartment: { apartmentId: 'apt-1', buildingId: 'building-1' },
    },
    queryImpl(sql) {
      if (sql.includes('SELECT * FROM device_health')) return { rows: [] };
      if (sql.includes('SELECT 1 FROM call_delivery_acks')) return { rows: [] };
      if (sql.includes('INSERT INTO device_health')) return { rows: [] };
      if (sql.includes('INSERT INTO device_tokens')) return { rows: [] };
      if (sql.includes('DELETE FROM device_tokens')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const req = createRequest({
    method: 'POST',
    url: '/register-fcm-token',
    headers: { authorization: 'Bearer resident-token' },
    body: { token: 'fcm-token', userId: 'user-2', apartmentId: 'apt-2', platform: 'android' },
  });
  const res = createResponse();

  await harness.handleRequest(req, res);

  const deleteCall = harness.queryCalls.find(({ sql }) => sql.includes('DELETE FROM device_tokens'));
  assert.deepEqual(deleteCall.params, ['user-1', 'fcm-token']);
});

test('call ack rejects calls outside resident apartment scope', async () => {
  const harness = createHandleRequestHarness({
    residentContext: {
      userId: 'user-1',
      apartmentIds: ['apt-1'],
      primaryApartmentId: 'apt-1',
      primaryApartment: { apartmentId: 'apt-1', buildingId: 'building-1' },
    },
    queryImpl(sql) {
      if (sql.includes('SELECT status, apartment_id FROM calls')) {
        return { rows: [{ status: 'calling', apartment_id: 'apt-2' }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const req = createRequest({
    method: 'POST',
    url: '/api/home/calls/call-1/ack',
    headers: { authorization: 'Bearer resident-token' },
    body: { event: 'push-received', deviceToken: 'token-1', tokenType: 'fcm', platform: 'ios' },
  });
  const res = createResponse();

  await harness.handleRequest(req, res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { error: 'Forbidden' });
});

test('call ack succeeds for an owned device token and apartment scope', async () => {
  const harness = createHandleRequestHarness({
    residentContext: {
      userId: 'user-1',
      apartmentIds: ['apt-1'],
      primaryApartmentId: 'apt-1',
      primaryApartment: { apartmentId: 'apt-1', buildingId: 'building-1' },
    },
    queryImpl(sql, params) {
      if (sql.includes('SELECT status, apartment_id FROM calls')) {
        return { rows: [{ status: 'calling', apartment_id: 'apt-1' }] };
      }
      if (sql.includes('FROM device_tokens')) {
        return { rows: [{ apartment_id: 'apt-1' }] };
      }
      if (sql.includes('INSERT INTO call_delivery_acks')) return { rows: [] };
      if (sql.includes('SELECT * FROM device_health')) return { rows: [] };
      if (sql.includes('SELECT 1 FROM call_delivery_acks')) return { rows: [] };
      if (sql.includes('INSERT INTO device_health')) return { rows: [] };
      if (sql.includes('SELECT apartment_id FROM calls')) return { rows: [{ apartment_id: 'apt-1' }] };
      if (sql.includes('UPDATE call_delivery_attempts')) return { rows: [] };
      if (sql.includes('SELECT intercom_id FROM calls')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    },
  });

  const req = createRequest({
    method: 'POST',
    url: '/api/home/calls/call-1/ack',
    headers: { authorization: 'Bearer resident-token' },
    body: { event: 'push-received', deviceToken: 'token-1', tokenType: 'fcm', platform: 'ios', userId: 'spoof-user' },
  });
  const res = createResponse();

  await harness.handleRequest(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, callStatus: 'calling' });
  const ackInsert = harness.queryCalls.find(({ sql }) => sql.includes('INSERT INTO call_delivery_acks'));
  assert.deepEqual(ackInsert.params, ['call-1', 'user-1', 'token-1', 'fcm', 'ios', 'push-received']);
});

test('http accept rejects calls outside resident apartment scope', async () => {
  const harness = createHandleRequestHarness({
    residentContext: {
      userId: 'user-1',
      apartmentIds: ['apt-1'],
      primaryApartmentId: 'apt-1',
      primaryApartment: { apartmentId: 'apt-1', buildingId: 'building-1' },
    },
    queryImpl(sql) {
      if (sql.includes('SELECT id, status, apartment_id, intercom_id, building_id FROM calls')) {
        return {
          rows: [{ id: 'call-1', status: 'calling', apartment_id: 'apt-2', intercom_id: 'intercom-1', building_id: 'building-1' }],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const req = createRequest({
    method: 'POST',
    url: '/api/home/calls/call-1/accept',
    headers: { authorization: 'Bearer resident-token' },
    body: {},
  });
  const res = createResponse();

  await harness.handleRequest(req, res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { error: 'Forbidden' });
});

test('http accept uses authenticated resident user id', async () => {
  const harness = createHandleRequestHarness({
    residentContext: {
      userId: 'user-1',
      apartmentIds: ['apt-1'],
      primaryApartmentId: 'apt-1',
      primaryApartment: { apartmentId: 'apt-1', buildingId: 'building-1' },
    },
    queryImpl(sql) {
      if (sql.includes('SELECT id, status, apartment_id, intercom_id, building_id FROM calls')) {
        return {
          rows: [{ id: 'call-1', status: 'calling', apartment_id: 'apt-1', intercom_id: 'intercom-1', building_id: 'building-1' }],
        };
      }
      if (sql.includes("UPDATE calls SET status = 'accepted'")) {
        return { rows: [{ id: 'call-1' }] };
      }
      if (sql.includes('INSERT INTO audit_logs')) return { rows: [] };
      if (sql.includes('SELECT token, token_type FROM device_tokens')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const req = createRequest({
    method: 'POST',
    url: '/api/home/calls/call-1/accept',
    headers: { authorization: 'Bearer resident-token' },
    body: {},
  });
  const res = createResponse();

  await harness.handleRequest(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { status: 'accepted', callId: 'call-1' });
  assert.deepEqual(harness.httpAcceptCalls, [{ intercomId: 'intercom-1', userId: 'user-1' }]);
});