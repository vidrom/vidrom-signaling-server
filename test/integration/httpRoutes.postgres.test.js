const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { requireWithMocks } = require('../wsTestHarness');
const { canRunPostgresIntegration, startPostgresHarness } = require('./postgresHarness');
const { IDS, seedResidentFixture, seedResidentCallFixture } = require('./postgresFixtures');

let dockerAvailable;
let harness;

test.before(async () => {
  dockerAvailable = await canRunPostgresIntegration();
  if (!dockerAvailable) return;
  harness = await startPostgresHarness();
});

test.after(async () => {
  if (harness) {
    await harness.close();
  }
});

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

async function flushAsync(times = 2) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createHandleRequestHarness(authModule, options = {}) {
  const state = {
    timerCallback: null,
    timerCallId: null,
    timerMs: null,
    apartmentMessages: [],
    intercomMessages: [],
    canceledRetries: [],
    voipPushCalls: [],
    fcmSendCalls: [],
  };
  const intercom = {
    ws: {
      readyState: 1,
      send(message) {
        state.intercomMessages.push(JSON.parse(message));
      },
    },
  };
  const activeCallState = options.activeCallState || {
    acceptedBy: null,
    acceptedWs: null,
    httpAcceptedBy: null,
  };

  const { handleRequest } = requireWithMocks('../../src/httpRoutes', {
    './auth': {
      generateDeviceToken() {
        return 'device-token';
      },
      verifyToken() {
        return { deviceId: 'intercom-1', buildingId: 'building-1', role: 'intercom' };
      },
      async authenticateAdminRequest() {
        const err = new Error('Unauthorized');
        err.status = 401;
        err.expose = true;
        throw err;
      },
      authenticateResidentRequest: authModule.authenticateResidentRequest,
      residentHasApartmentAccess: authModule.residentHasApartmentAccess,
    },
    './connectionState': {
      clients: { intercom: null, home: null },
      fcmTokens: new Map(),
      voipTokens: new Map(),
      activeCalls: new Map(),
      intercoms: new Map(),
      getIntercom() {
        return intercom;
      },
      getHomeClients() {
        return new Map();
      },
      clearPendingRing() {},
      sendToApartment(apartmentId, payload) {
        state.apartmentMessages.push({ apartmentId, payload });
      },
      startAcceptTimer(callId, timeoutMs, callback) {
        state.timerCallId = callId;
        state.timerMs = timeoutMs;
        state.timerCallback = callback;
      },
      activeCall: {
        getByApartment() {
          return null;
        },
        httpAccept(_intercomId, userId) {
          activeCallState.acceptedBy = `http:${userId}`;
          activeCallState.httpAcceptedBy = userId;
          return true;
        },
        get() {
          return activeCallState;
        },
      },
    },
    './apnsService': {
      isAPNsReady() {
        return options.isAPNsReady || false;
      },
      async sendVoipPush(...args) {
        state.voipPushCalls.push(args);
        if (options.sendVoipPushImpl) {
          return options.sendVoipPushImpl(...args);
        }
        return { success: true };
      },
    },
    './db': {
      query: harness.query.bind(harness),
    },
    './retryOrchestrator': {
      cancelRetries(callId) {
        state.canceledRetries.push(callId);
      },
    },
    'firebase-admin': {
      messaging() {
        return {
          async send(message) {
            state.fcmSendCalls.push(message);
            if (options.fcmSendImpl) {
              return options.fcmSendImpl(message);
            }
            return undefined;
          },
        };
      },
    },
  });

  return { handleRequest, state, activeCallState };
}

function createResidentAuthModule() {
  return requireWithMocks('../../src/auth', {
    'firebase-admin': {
      auth() {
        return {
          async verifyIdToken(token) {
            assert.equal(token, 'resident-token');
            return {
              uid: 'firebase-user-1',
              email: 'resident@example.com',
              email_verified: true,
            };
          },
        };
      },
    },
    './db': {
      query: harness.query.bind(harness),
    },
  });
}

test('PostgreSQL-backed resolve-apartment returns the authenticated resident apartment from the real schema', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentFixture(harness, { firebaseUid: 'firebase-user-1' });

  const authModule = createResidentAuthModule();
  const routeHarness = createHandleRequestHarness(authModule);

  const req = createRequest({
    method: 'POST',
    url: '/api/home/resolve-apartment',
    headers: { authorization: 'Bearer resident-token' },
    body: { email: 'spoof@example.com' },
  });
  const res = createResponse();

  await routeHarness.handleRequest(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    userId: IDS.residentUser,
    userName: 'Resident One',
    apartmentId: IDS.apartment1,
    apartmentNumber: '12A',
    apartmentName: 'Unit 12A',
    buildingId: IDS.building1,
    buildingName: 'Vidrom Towers',
    buildingAddress: '1 Main St',
    apartmentIds: [IDS.apartment1, IDS.apartment2],
    primaryApartmentId: IDS.apartment1,
  });
});

test('PostgreSQL-backed register-fcm-token persists server-derived ownership and removes stale tokens', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentFixture(harness, { firebaseUid: 'firebase-user-1' });
  await harness.query(
    `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, updated_at)
     VALUES ($1, $2, 'old-token', 'fcm', 'android', NOW())`,
    [IDS.apartment2, IDS.residentUser]
  );

  const authModule = createResidentAuthModule();
  const routeHarness = createHandleRequestHarness(authModule);

  const req = createRequest({
    method: 'POST',
    url: '/register-fcm-token',
    headers: { authorization: 'Bearer resident-token' },
    body: {
      token: 'new-token',
      apartmentId: 'spoof-apt',
      userId: 'spoof-user',
      platform: 'ios',
    },
  });
  const res = createResponse();

  await routeHarness.handleRequest(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });

  const tokenRows = await harness.query(
    `SELECT apartment_id, user_id, token, token_type, platform
     FROM device_tokens
     ORDER BY token ASC`
  );
  assert.deepEqual(tokenRows.rows, [
    {
      apartment_id: IDS.apartment1,
      user_id: IDS.residentUser,
      token: 'new-token',
      token_type: 'fcm',
      platform: 'ios',
    },
  ]);

  const healthRows = await harness.query(
    `SELECT device_token, token_type, user_id, apartment_id, platform
     FROM device_health
     ORDER BY device_token ASC`
  );
  assert.deepEqual(healthRows.rows, [
    {
      device_token: 'new-token',
      token_type: 'fcm',
      user_id: IDS.residentUser,
      apartment_id: IDS.apartment1,
      platform: 'ios',
    },
  ]);
});

test('PostgreSQL-backed call ack persists delivery ack state for an owned resident device', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentCallFixture(harness, { firebaseUid: 'firebase-user-1', callStatus: 'calling' });
  await harness.query(
    `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, updated_at)
     VALUES ($1, $2, 'fcm-token-1', 'fcm', 'ios', NOW())`,
    [IDS.apartment1, IDS.residentUser]
  );
  await harness.query(
    `INSERT INTO call_delivery_attempts (
      call_id, user_id, device_token, token_type, platform, attempt_number, delivery_state, last_attempt_at
    ) VALUES (
      $1, $2, 'fcm-token-1', 'fcm', 'ios', 1, 'push-sent', NOW()
    )`,
    [IDS.call1, IDS.residentUser]
  );

  const authModule = createResidentAuthModule();
  const routeHarness = createHandleRequestHarness(authModule);

  const req = createRequest({
    method: 'POST',
    url: `/api/home/calls/${IDS.call1}/ack`,
    headers: { authorization: 'Bearer resident-token' },
    body: {
      event: 'push-received',
      deviceToken: 'fcm-token-1',
      tokenType: 'fcm',
      platform: 'ios',
    },
  });
  const res = createResponse();

  await routeHarness.handleRequest(req, res);
  await flushAsync();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, callStatus: 'calling' });

  const ackRows = await harness.query(
    `SELECT call_id, user_id, device_token, token_type, platform, event
     FROM call_delivery_acks`
  );
  assert.deepEqual(ackRows.rows, [
    {
      call_id: IDS.call1,
      user_id: IDS.residentUser,
      device_token: 'fcm-token-1',
      token_type: 'fcm',
      platform: 'ios',
      event: 'push-received',
    },
  ]);

  const attemptRows = await harness.query(
    `SELECT delivery_state, acked_at IS NOT NULL AS acked
     FROM call_delivery_attempts
     WHERE call_id = $1 AND device_token = 'fcm-token-1'`,
    [IDS.call1]
  );
  assert.deepEqual(attemptRows.rows, [{ delivery_state: 'push-received', acked: true }]);

  const healthRows = await harness.query(
    `SELECT device_token, token_type, user_id, apartment_id, platform, last_call_ack_event, last_ack_at IS NOT NULL AS has_ack
     FROM device_health
     WHERE device_token = 'fcm-token-1' AND token_type = 'fcm'`
  );
  assert.deepEqual(healthRows.rows, [
    {
      device_token: 'fcm-token-1',
      token_type: 'fcm',
      user_id: IDS.residentUser,
      apartment_id: IDS.apartment1,
      platform: 'ios',
      last_call_ack_event: 'push-received',
      has_ack: true,
    },
  ]);
});

test('PostgreSQL-backed HTTP accept updates the call and writes a call-accepted audit row', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentCallFixture(harness, { firebaseUid: 'firebase-user-1', callStatus: 'calling' });
  await harness.query(
    `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, updated_at)
     VALUES ($1, $2, 'notify-token', 'fcm', 'android', NOW())`,
    [IDS.apartment1, IDS.residentUser]
  );

  const authModule = createResidentAuthModule();
  const routeHarness = createHandleRequestHarness(authModule);

  const req = createRequest({
    method: 'POST',
    url: `/api/home/calls/${IDS.call1}/accept`,
    headers: { authorization: 'Bearer resident-token' },
    body: {},
  });
  const res = createResponse();

  await routeHarness.handleRequest(req, res);
  await flushAsync();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { status: 'accepted', callId: IDS.call1 });

  const callRows = await harness.query(
    `SELECT status FROM calls WHERE id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(callRows.rows, [{ status: 'accepted' }]);

  const auditRows = await harness.query(
    `SELECT event_type, building_id, apartment_id, user_id, intercom_id, call_id, description
     FROM audit_logs
     WHERE call_id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, [
    {
      event_type: 'call-accepted',
      building_id: IDS.building1,
      apartment_id: IDS.apartment1,
      user_id: IDS.residentUser,
      intercom_id: IDS.intercom1,
      call_id: IDS.call1,
      description: 'Call accepted via HTTP',
    },
  ]);
});

test('PostgreSQL-backed HTTP accept cleanup deletes stale FCM and VoIP tokens during call-taken push fallback', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentCallFixture(harness, { firebaseUid: 'firebase-user-1', callStatus: 'calling' });
  await harness.query(
    `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, updated_at)
     VALUES ($1, $2, 'dead-http-fcm', 'fcm', 'android', NOW()),
            ($1, $2, 'dead-http-voip', 'voip', 'ios', NOW())`,
    [IDS.apartment1, IDS.residentUser]
  );

  const authModule = createResidentAuthModule();
  const routeHarness = createHandleRequestHarness(authModule, {
    isAPNsReady: true,
    sendVoipPushImpl: async () => ({ success: false, reason: 'BadDeviceToken' }),
    fcmSendImpl: async () => {
      const err = new Error('gone');
      err.code = 'messaging/registration-token-not-registered';
      throw err;
    },
  });

  const req = createRequest({
    method: 'POST',
    url: `/api/home/calls/${IDS.call1}/accept`,
    headers: { authorization: 'Bearer resident-token' },
    body: {},
  });
  const res = createResponse();

  await routeHarness.handleRequest(req, res);
  await flushAsync(6);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { status: 'accepted', callId: IDS.call1 });

  const tokenRows = await harness.query(
    `SELECT token, token_type FROM device_tokens ORDER BY token ASC`
  );
  assert.deepEqual(tokenRows.rows, []);

  const healthRows = await harness.query(
    `SELECT device_token, token_type, user_id, apartment_id, last_push_error, last_push_failure IS NOT NULL AS has_failure
     FROM device_health
     ORDER BY device_token ASC`
  );
  assert.deepEqual(healthRows.rows, [
    {
      device_token: 'dead-http-fcm',
      token_type: 'fcm',
      user_id: IDS.residentUser,
      apartment_id: IDS.apartment1,
      last_push_error: 'gone',
      has_failure: true,
    },
    {
      device_token: 'dead-http-voip',
      token_type: 'voip',
      user_id: IDS.residentUser,
      apartment_id: IDS.apartment1,
      last_push_error: 'BadDeviceToken',
      has_failure: true,
    },
  ]);

  assert.deepEqual(routeHarness.state.fcmSendCalls.map((message) => message.token), ['dead-http-fcm']);
  assert.deepEqual(routeHarness.state.voipPushCalls.map((args) => args[0]), ['dead-http-voip']);
});

test('PostgreSQL-backed HTTP accept timeout reverts the call, writes audit state, and clears the in-memory reservation', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentCallFixture(harness, { firebaseUid: 'firebase-user-1', callStatus: 'calling' });
  await harness.query(
    `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, updated_at)
     VALUES ($1, $2, 'notify-token', 'fcm', 'android', NOW())`,
    [IDS.apartment1, IDS.residentUser]
  );

  const authModule = createResidentAuthModule();
  const routeHarness = createHandleRequestHarness(authModule, {
    activeCallState: {
      acceptedBy: null,
      acceptedWs: null,
      httpAcceptedBy: null,
    },
  });

  const acceptReq = createRequest({
    method: 'POST',
    url: `/api/home/calls/${IDS.call1}/accept`,
    headers: { authorization: 'Bearer resident-token' },
    body: {},
  });
  const acceptRes = createResponse();

  await routeHarness.handleRequest(acceptReq, acceptRes);
  await flushAsync();

  assert.equal(acceptRes.statusCode, 200);
  assert.equal(routeHarness.state.timerCallId, IDS.call1);
  assert.equal(routeHarness.state.timerMs, 10000);
  assert.equal(typeof routeHarness.state.timerCallback, 'function');
  assert.equal(routeHarness.activeCallState.httpAcceptedBy, IDS.residentUser);
  assert.deepEqual(routeHarness.state.canceledRetries, [IDS.call1]);

  await routeHarness.state.timerCallback();
  await flushAsync(3);

  const callRows = await harness.query(
    `SELECT status FROM calls WHERE id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(callRows.rows, [{ status: 'calling' }]);

  const auditRows = await harness.query(
    `SELECT event_type, building_id, apartment_id, intercom_id, call_id, description
     FROM audit_logs
     WHERE call_id = $1
     ORDER BY created_at ASC`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, [
    {
      event_type: 'call-accepted',
      building_id: IDS.building1,
      apartment_id: IDS.apartment1,
      intercom_id: IDS.intercom1,
      call_id: IDS.call1,
      description: 'Call accepted via HTTP',
    },
    {
      event_type: 'accept-timeout',
      building_id: IDS.building1,
      apartment_id: IDS.apartment1,
      intercom_id: IDS.intercom1,
      call_id: IDS.call1,
      description: 'HTTP accept reservation expired — device did not connect',
    },
  ]);

  assert.equal(routeHarness.activeCallState.acceptedBy, null);
  assert.equal(routeHarness.activeCallState.acceptedWs, null);
  assert.equal(routeHarness.activeCallState.httpAcceptedBy, null);
  assert.deepEqual(routeHarness.state.intercomMessages.slice(-1), [{ type: 'accept-timeout', callId: IDS.call1 }]);
  assert.deepEqual(routeHarness.state.apartmentMessages.slice(-1), [
    {
      apartmentId: IDS.apartment1,
      payload: { type: 'ring', callId: IDS.call1 },
    },
  ]);
});