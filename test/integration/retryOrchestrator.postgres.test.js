const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { FakeWebSocket, flushAsync, requireWithMocks } = require('../wsTestHarness');
const { canRunPostgresIntegration, startPostgresHarness } = require('./postgresHarness');
const { IDS, seedResidentCallFixture } = require('./postgresFixtures');

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

function createRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;

  process.nextTick(() => {
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

function createAckRouteHarness(authModule) {
  const { handleRequest } = requireWithMocks('../../src/httpRoutes', {
    './auth': {
      generateDeviceToken() {
        return 'device-token';
      },
      verifyToken() {
        return { deviceId: IDS.intercom1, buildingId: IDS.building1, role: 'intercom' };
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
        httpAccept() {
          return false;
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
      query: harness.query.bind(harness),
    },
    './retryOrchestrator': {
      cancelRetries() {},
    },
    'firebase-admin': {
      messaging() {
        return { async send() {} };
      },
    },
  });

  return { handleRequest };
}

function createRetryOrchestratorHarness({
  intercomWs = new FakeWebSocket('intercom'),
  isAPNsReady = false,
  sendVoipPushImpl = async () => ({ success: true }),
  fcmSendImpl = async () => undefined,
} = {}) {
  const fcmSendCalls = [];
  const voipPushCalls = [];

  const orchestrator = requireWithMocks('../../src/retryOrchestrator', {
    './db': {
      query: harness.query.bind(harness),
    },
    './apnsService': {
      isAPNsReady() {
        return isAPNsReady;
      },
      async sendVoipPush(...args) {
        voipPushCalls.push(args);
        return sendVoipPushImpl(...args);
      },
    },
    './connectionState': {
      getIntercom(targetIntercomId) {
        if (targetIntercomId !== IDS.intercom1) {
          return null;
        }
        return { deviceId: IDS.intercom1, ws: intercomWs };
      },
    },
    'firebase-admin': {
      messaging() {
        return {
          async send(message) {
            fcmSendCalls.push(message);
            return fcmSendImpl(message);
          },
        };
      },
    },
  });

  return {
    ...orchestrator,
    intercomWs,
    fcmSendCalls,
    voipPushCalls,
  };
}

async function withFakeTimers(run) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];

  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false, fired: false };
    timers.push(timer);
    return timer;
  };

  global.clearTimeout = (timer) => {
    if (timer) {
      timer.cleared = true;
    }
  };

  try {
    await run({
      timers,
      async fireTimer(delay) {
        const timer = timers.find((entry) => entry.delay === delay && !entry.fired);
        assert.ok(timer, `expected timer for ${delay}ms`);
        timer.fired = true;
        timer.callback();
        await flushAsync(8);
      },
    });
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

test('PostgreSQL-backed retry orchestration persists new delivery attempts for unacked devices', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentCallFixture(harness, { firebaseUid: 'firebase-user-1', callStatus: 'calling' });
  await harness.query(
    `UPDATE calls SET expires_at = NOW() + make_interval(secs => 30) WHERE id = $1`,
    [IDS.call1]
  );
  await harness.query(
    `INSERT INTO call_delivery_attempts (
       call_id, user_id, device_token, token_type, platform, attempt_number, delivery_state, last_attempt_at
     ) VALUES (
       $1, $2, 'retry-fcm-token', 'fcm', 'android', 1, 'push-sent', NOW()
     )`,
    [IDS.call1, IDS.residentUser]
  );

  const retryHarness = createRetryOrchestratorHarness();

  await withFakeTimers(async ({ timers, fireTimer }) => {
    retryHarness.startRetries(IDS.call1, 30);

    assert.deepEqual(timers.map((timer) => timer.delay), [3000, 8000, 15000]);

    await fireTimer(3000);
  });

  const attemptRows = await harness.query(
    `SELECT attempt_number, device_token, delivery_state, last_error
     FROM call_delivery_attempts
     WHERE call_id = $1
     ORDER BY attempt_number ASC`,
    [IDS.call1]
  );
  assert.deepEqual(attemptRows.rows, [
    {
      attempt_number: 1,
      device_token: 'retry-fcm-token',
      delivery_state: 'push-sent',
      last_error: null,
    },
    {
      attempt_number: 2,
      device_token: 'retry-fcm-token',
      delivery_state: 'push-sent',
      last_error: null,
    },
  ]);

  assert.equal(retryHarness.fcmSendCalls.length, 1);
  assert.equal(retryHarness.fcmSendCalls[0].token, 'retry-fcm-token');
  assert.equal(retryHarness.fcmSendCalls[0].data.callId, IDS.call1);
});

test('PostgreSQL-backed retry failures delete stale tokens and update device health', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentCallFixture(harness, { firebaseUid: 'firebase-user-1', callStatus: 'calling' });
  await harness.query(
    `UPDATE calls SET expires_at = NOW() + make_interval(secs => 30) WHERE id = $1`,
    [IDS.call1]
  );
  await harness.query(
    `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, updated_at)
     VALUES ($1, $2, 'retry-dead-fcm', 'fcm', 'android', NOW()),
            ($1, $2, 'retry-dead-voip', 'voip', 'ios', NOW())`,
    [IDS.apartment1, IDS.residentUser]
  );
  await harness.query(
    `INSERT INTO call_delivery_attempts (
       call_id, user_id, device_token, token_type, platform, attempt_number, delivery_state, last_attempt_at
     ) VALUES
       ($1, $2, 'retry-dead-fcm', 'fcm', 'android', 1, 'push-sent', NOW()),
       ($1, $2, 'retry-dead-voip', 'voip', 'ios', 1, 'push-sent', NOW())`,
    [IDS.call1, IDS.residentUser]
  );

  const retryHarness = createRetryOrchestratorHarness({
    isAPNsReady: true,
    sendVoipPushImpl: async () => ({ success: false, reason: 'BadDeviceToken' }),
    fcmSendImpl: async () => {
      const err = new Error('gone');
      err.code = 'messaging/registration-token-not-registered';
      throw err;
    },
  });

  await withFakeTimers(async ({ fireTimer }) => {
    retryHarness.startRetries(IDS.call1, 30);
    await fireTimer(3000);
  });

  const tokenRows = await harness.query(
    `SELECT token, token_type FROM device_tokens ORDER BY token ASC`
  );
  assert.deepEqual(tokenRows.rows, []);

  const attemptRows = await harness.query(
    `SELECT device_token, token_type, attempt_number, delivery_state, last_error
     FROM call_delivery_attempts
     WHERE call_id = $1
     ORDER BY device_token ASC, attempt_number ASC`,
    [IDS.call1]
  );
  assert.deepEqual(attemptRows.rows, [
    {
      device_token: 'retry-dead-fcm',
      token_type: 'fcm',
      attempt_number: 1,
      delivery_state: 'push-sent',
      last_error: null,
    },
    {
      device_token: 'retry-dead-fcm',
      token_type: 'fcm',
      attempt_number: 2,
      delivery_state: 'push-failed',
      last_error: 'gone',
    },
    {
      device_token: 'retry-dead-voip',
      token_type: 'voip',
      attempt_number: 1,
      delivery_state: 'push-sent',
      last_error: null,
    },
    {
      device_token: 'retry-dead-voip',
      token_type: 'voip',
      attempt_number: 2,
      delivery_state: 'push-failed',
      last_error: 'BadDeviceToken',
    },
  ]);

  const healthRows = await harness.query(
    `SELECT device_token, token_type, user_id, apartment_id, last_push_error, last_push_failure IS NOT NULL AS has_failure
     FROM device_health
     ORDER BY device_token ASC`
  );
  assert.deepEqual(healthRows.rows, [
    {
      device_token: 'retry-dead-fcm',
      token_type: 'fcm',
      user_id: IDS.residentUser,
      apartment_id: IDS.apartment1,
      last_push_error: 'gone',
      has_failure: true,
    },
    {
      device_token: 'retry-dead-voip',
      token_type: 'voip',
      user_id: IDS.residentUser,
      apartment_id: IDS.apartment1,
      last_push_error: 'BadDeviceToken',
      has_failure: true,
    },
  ]);
});

test('PostgreSQL-backed final retry check writes delivery-degraded and notifies the intercom', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentCallFixture(harness, { firebaseUid: 'firebase-user-1', callStatus: 'calling' });
  await harness.query(
    `UPDATE calls SET expires_at = NOW() + make_interval(secs => 30) WHERE id = $1`,
    [IDS.call1]
  );
  await harness.query(
    `INSERT INTO call_delivery_attempts (
       call_id, user_id, device_token, token_type, platform, attempt_number, delivery_state, last_attempt_at
     ) VALUES (
       $1, $2, 'retry-fcm-token', 'fcm', 'android', 1, 'push-sent', NOW()
     )`,
    [IDS.call1, IDS.residentUser]
  );

  const retryHarness = createRetryOrchestratorHarness();

  await withFakeTimers(async ({ fireTimer }) => {
    retryHarness.startRetries(IDS.call1, 30);

    await fireTimer(3000);
    await fireTimer(8000);
    await fireTimer(15000);
  });

  const attemptRows = await harness.query(
    `SELECT attempt_number, delivery_state
     FROM call_delivery_attempts
     WHERE call_id = $1
     ORDER BY attempt_number ASC`,
    [IDS.call1]
  );
  assert.deepEqual(attemptRows.rows, [
    { attempt_number: 1, delivery_state: 'push-sent' },
    { attempt_number: 2, delivery_state: 'push-sent' },
    { attempt_number: 3, delivery_state: 'push-sent' },
  ]);

  const auditRows = await harness.query(
    `SELECT event_type, building_id, apartment_id, intercom_id, call_id, description
     FROM audit_logs
     WHERE call_id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, [
    {
      event_type: 'delivery-degraded',
      building_id: IDS.building1,
      apartment_id: IDS.apartment1,
      intercom_id: IDS.intercom1,
      call_id: IDS.call1,
      description: `No device acknowledged ring for call ${IDS.call1} after all retry attempts`,
    },
  ]);

  assert.deepEqual(retryHarness.intercomWs.sentMessages.at(-1), {
    type: 'ring-progress',
    callId: IDS.call1,
    noResponse: true,
  });
  assert.equal(retryHarness.fcmSendCalls.length, 2);
});

test('PostgreSQL-backed delivery ack suppresses retry escalation and delivery-degraded state', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentCallFixture(harness, { firebaseUid: 'firebase-user-1', callStatus: 'calling' });
  await harness.query(
    `UPDATE calls SET expires_at = NOW() + make_interval(secs => 30) WHERE id = $1`,
    [IDS.call1]
  );
  await harness.query(
    `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, updated_at)
     VALUES ($1, $2, 'retry-fcm-token', 'fcm', 'ios', NOW())`,
    [IDS.apartment1, IDS.residentUser]
  );
  await harness.query(
    `INSERT INTO call_delivery_attempts (
       call_id, user_id, device_token, token_type, platform, attempt_number, delivery_state, last_attempt_at
     ) VALUES (
       $1, $2, 'retry-fcm-token', 'fcm', 'ios', 1, 'push-sent', NOW()
     )`,
    [IDS.call1, IDS.residentUser]
  );

  const authModule = createResidentAuthModule();
  const routeHarness = createAckRouteHarness(authModule);
  const retryHarness = createRetryOrchestratorHarness();

  const ackReq = createRequest({
    method: 'POST',
    url: `/api/home/calls/${IDS.call1}/ack`,
    headers: { authorization: 'Bearer resident-token' },
    body: {
      event: 'push-received',
      deviceToken: 'retry-fcm-token',
      tokenType: 'fcm',
      platform: 'ios',
    },
  });
  const ackRes = createResponse();

  await routeHarness.handleRequest(ackReq, ackRes);
  await flushAsync(6);

  assert.equal(ackRes.statusCode, 200);
  assert.deepEqual(JSON.parse(ackRes.body), { ok: true, callStatus: 'calling' });

  await withFakeTimers(async ({ fireTimer }) => {
    retryHarness.startRetries(IDS.call1, 30);

    await fireTimer(3000);
    await fireTimer(8000);
    await fireTimer(15000);
  });

  const attemptRows = await harness.query(
    `SELECT attempt_number, delivery_state, acked_at IS NOT NULL AS acked
     FROM call_delivery_attempts
     WHERE call_id = $1
     ORDER BY attempt_number ASC`,
    [IDS.call1]
  );
  assert.deepEqual(attemptRows.rows, [
    {
      attempt_number: 1,
      delivery_state: 'push-received',
      acked: true,
    },
  ]);

  const ackRows = await harness.query(
    `SELECT event, device_token
     FROM call_delivery_acks
     WHERE call_id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(ackRows.rows, [
    {
      event: 'push-received',
      device_token: 'retry-fcm-token',
    },
  ]);

  const auditRows = await harness.query(
    `SELECT event_type
     FROM audit_logs
     WHERE call_id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, []);

  assert.equal(retryHarness.fcmSendCalls.length, 0);
  assert.deepEqual(retryHarness.intercomWs.sentMessages, []);
});