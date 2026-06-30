const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FakeWebSocket,
  createConnectionStateMock,
  flushAsync,
  requireWithMocks,
} = require('../wsTestHarness');
const { canRunPostgresIntegration, startPostgresHarness } = require('./postgresHarness');
const { IDS, seedResidentRingFixture, seedSleepModeRingFixture } = require('./postgresFixtures');

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

function createUuidMock(values) {
  let index = 0;
  return {
    v4() {
      const value = values[index];
      index += 1;
      return value || `uuid-${index}`;
    },
  };
}

function createPostgresWsHandlerHarness({
  uuidValues = [],
  isAPNsReady = false,
  sendVoipPushImpl = async () => ({ success: true }),
  fcmSendImpl = async () => undefined,
} = {}) {
  const connectionStateMock = createConnectionStateMock();
  const retryCalls = [];
  const cancelRetryCalls = [];
  const voipPushCalls = [];
  const fcmSendCalls = [];

  const { handleConnection } = requireWithMocks('../../src/wsHandler', {
    './auth': {
      verifyToken() {
        return { deviceId: IDS.intercom1, buildingId: IDS.building1, role: 'intercom' };
      },
      async authenticateResidentToken() {
        return {
          userId: IDS.residentUser,
          apartmentIds: [IDS.apartment1],
          primaryApartmentId: IDS.apartment1,
          buildingIds: [IDS.building1],
          apartments: [{ apartmentId: IDS.apartment1, buildingId: IDS.building1 }],
        };
      },
      residentHasApartmentAccess(context, apartmentId) {
        return context.apartmentIds.includes(apartmentId);
      },
    },
    './devices': {
      async getDevice() {
        return { id: IDS.intercom1, buildingId: IDS.building1, status: 'active' };
      },
    },
    './connectionState': connectionStateMock,
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
    './retryOrchestrator': {
      startRetries(callId, ringTimeoutSec) {
        retryCalls.push({ callId, ringTimeoutSec });
      },
      cancelRetries(callId) {
        cancelRetryCalls.push(callId);
      },
    },
    './deviceHealthScore': {
      computeDeviceHealth() {
        return { health_score: 100, health_status: 'healthy' };
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
    uuid: createUuidMock(uuidValues),
  });

  return {
    handleConnection,
    connectionStateMock,
    retryCalls,
    cancelRetryCalls,
    voipPushCalls,
    fcmSendCalls,
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
        const timer = timers.find((entry) => entry.delay === delay && !entry.fired && !entry.cleared);
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

test('PostgreSQL-backed ring cleanup deletes stale FCM and VoIP tokens after failed push delivery', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentRingFixture(harness, { firebaseUid: 'firebase-user-1' });
  await harness.query(
    `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, updated_at)
     VALUES ($1, $2, 'dead-fcm', 'fcm', 'android', NOW()),
            ($1, $2, 'dead-voip', 'voip', 'ios', NOW())`,
    [IDS.apartment1, IDS.residentUser]
  );

  const serverHarness = createPostgresWsHandlerHarness({
    uuidValues: ['connection-1', IDS.call1],
    isAPNsReady: true,
    sendVoipPushImpl: async () => ({ success: false, reason: 'BadDeviceToken' }),
    fcmSendImpl: async () => {
      const err = new Error('gone');
      err.code = 'messaging/registration-token-not-registered';
      throw err;
    },
  });

  const intercomWs = new FakeWebSocket('intercom');
  serverHarness.handleConnection(intercomWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
  await flushAsync(6);

  const tokenRows = await harness.query(
    `SELECT token, token_type FROM device_tokens ORDER BY token ASC`
  );
  assert.deepEqual(tokenRows.rows, []);

  const attemptRows = await harness.query(
    `SELECT device_token, token_type, delivery_state, last_error
     FROM call_delivery_attempts
     WHERE call_id = $1
     ORDER BY device_token ASC`,
    [IDS.call1]
  );
  assert.deepEqual(attemptRows.rows, [
    {
      device_token: 'dead-fcm',
      token_type: 'fcm',
      delivery_state: 'push-failed',
      last_error: 'gone',
    },
    {
      device_token: 'dead-voip',
      token_type: 'voip',
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
      device_token: 'dead-fcm',
      token_type: 'fcm',
      user_id: IDS.residentUser,
      apartment_id: IDS.apartment1,
      last_push_error: 'gone',
      has_failure: true,
    },
    {
      device_token: 'dead-voip',
      token_type: 'voip',
      user_id: IDS.residentUser,
      apartment_id: IDS.apartment1,
      last_push_error: 'BadDeviceToken',
      has_failure: true,
    },
  ]);

  const callRows = await harness.query(
    `SELECT id, status, apartment_id, intercom_id FROM calls WHERE id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(callRows.rows, [
    {
      id: IDS.call1,
      status: 'calling',
      apartment_id: IDS.apartment1,
      intercom_id: IDS.intercom1,
    },
  ]);

  assert.deepEqual(serverHarness.retryCalls, [{ callId: IDS.call1, ringTimeoutSec: 30 }]);
});

test('PostgreSQL-backed accept cleanup deletes stale FCM and VoIP tokens during call-taken push fallback', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentRingFixture(harness, { firebaseUid: 'firebase-user-1' });

  const serverHarness = createPostgresWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', IDS.call1],
    isAPNsReady: true,
    sendVoipPushImpl: async (...args) => {
      if (args[1] === 'call-taken') {
        return { success: false, reason: 'BadDeviceToken' };
      }
      return { success: true };
    },
    fcmSendImpl: async (message) => {
      if (message?.data?.type === 'call-taken') {
        const err = new Error('gone');
        err.code = 'messaging/registration-token-not-registered';
        throw err;
      }
      return undefined;
    },
  });

  const intercomWs = new FakeWebSocket('intercom');
  const homeWs = new FakeWebSocket('home');
  serverHarness.handleConnection(intercomWs);
  serverHarness.handleConnection(homeWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await homeWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
  await flushAsync(3);

  await harness.query(
    `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, updated_at)
     VALUES ($1, $2, 'dead-fcm-call-taken', 'fcm', 'android', NOW()),
            ($1, $2, 'dead-voip-call-taken', 'voip', 'ios', NOW())`,
    [IDS.apartment1, IDS.residentUser]
  );

  await homeWs.emitMessage({ type: 'accept', callId: IDS.call1, userId: IDS.residentUser });
  await flushAsync(6);

  const tokenRows = await harness.query(
    `SELECT token, token_type FROM device_tokens ORDER BY token ASC`
  );
  assert.deepEqual(tokenRows.rows, []);

  const callRows = await harness.query(
    `SELECT status FROM calls WHERE id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(callRows.rows, [{ status: 'accepted' }]);

  const auditRows = await harness.query(
    `SELECT event_type, call_id FROM audit_logs WHERE call_id = $1 ORDER BY created_at ASC`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, [
    { event_type: 'call-initiated', call_id: IDS.call1 },
    { event_type: 'call-accepted', call_id: IDS.call1 },
  ]);

  assert.equal(intercomWs.sentMessages.some((message) => message.type === 'accept' && message.callId === IDS.call1), true);
});

test('PostgreSQL-backed ring expiry marks the call unanswered, writes audit state, and cancels retries', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentRingFixture(harness, { firebaseUid: 'firebase-user-1' });

  const serverHarness = createPostgresWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', IDS.call1],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const homeWs = new FakeWebSocket('home');
  serverHarness.handleConnection(intercomWs);
  serverHarness.handleConnection(homeWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await homeWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
  await flushAsync(3);

  const expired = await serverHarness.connectionStateMock.triggerPendingRingExpiry(IDS.apartment1);
  await flushAsync(4);

  assert.equal(expired, true);
  assert.equal(serverHarness.connectionStateMock.activeCall.get(IDS.intercom1), null);
  assert.deepEqual(serverHarness.cancelRetryCalls, [IDS.call1]);

  const callRows = await harness.query(
    `SELECT status FROM calls WHERE id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(callRows.rows, [{ status: 'unanswered' }]);

  const auditRows = await harness.query(
    `SELECT event_type, call_id, description
     FROM audit_logs
     WHERE call_id = $1
     ORDER BY created_at ASC`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, [
    {
      event_type: 'call-initiated',
      call_id: IDS.call1,
      description: 'Ring started by intercom',
    },
    {
      event_type: 'call-unanswered',
      call_id: IDS.call1,
      description: 'Ring expired with no answer',
    },
  ]);
});

test('PostgreSQL-backed late-join during ringing writes the late-join-ring audit event', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentRingFixture(harness, { firebaseUid: 'firebase-user-1' });

  const serverHarness = createPostgresWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', IDS.call1, 'connection-3'],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const earlyHomeWs = new FakeWebSocket('home-early');
  const lateHomeWs = new FakeWebSocket('home-late');
  serverHarness.handleConnection(intercomWs);
  serverHarness.handleConnection(earlyHomeWs);
  serverHarness.handleConnection(lateHomeWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await earlyHomeWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
  await flushAsync(3);

  await lateHomeWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
  await flushAsync(4);

  assert.deepEqual(lateHomeWs.sentMessages.at(-1), {
    type: 'ring',
    callId: IDS.call1,
    buildingId: IDS.building1,
    apartmentId: IDS.apartment1,
    lateJoin: true,
  });

  const auditRows = await harness.query(
    `SELECT event_type, call_id, apartment_id, building_id, description
     FROM audit_logs
     WHERE call_id = $1
     ORDER BY created_at ASC`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, [
    {
      event_type: 'call-initiated',
      call_id: IDS.call1,
      apartment_id: IDS.apartment1,
      building_id: IDS.building1,
      description: 'Ring started by intercom',
    },
    {
      event_type: 'late-join-ring',
      call_id: IDS.call1,
      apartment_id: IDS.apartment1,
      building_id: IDS.building1,
      description: 'Device late-joined active ringing call',
    },
  ]);
});

test('PostgreSQL-backed late-join after accept writes the late-join-call-taken audit event', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentRingFixture(harness, { firebaseUid: 'firebase-user-1' });

  const serverHarness = createPostgresWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', IDS.call1, 'connection-3'],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const winningHomeWs = new FakeWebSocket('home-winning');
  const lateHomeWs = new FakeWebSocket('home-late');
  serverHarness.handleConnection(intercomWs);
  serverHarness.handleConnection(winningHomeWs);
  serverHarness.handleConnection(lateHomeWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await winningHomeWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
  await flushAsync(3);

  await winningHomeWs.emitMessage({ type: 'accept', callId: IDS.call1, userId: IDS.residentUser });
  await flushAsync(4);

  await lateHomeWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
  await flushAsync(4);

  assert.deepEqual(lateHomeWs.sentMessages.at(-1), {
    type: 'call-taken',
    callId: IDS.call1,
  });

  const auditRows = await harness.query(
    `SELECT event_type, call_id, apartment_id, building_id, description
     FROM audit_logs
     WHERE call_id = $1
     ORDER BY created_at ASC`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, [
    {
      event_type: 'call-initiated',
      call_id: IDS.call1,
      apartment_id: IDS.apartment1,
      building_id: IDS.building1,
      description: 'Ring started by intercom',
    },
    {
      event_type: 'call-accepted',
      call_id: IDS.call1,
      apartment_id: IDS.apartment1,
      building_id: IDS.building1,
      description: 'Call accepted by resident',
    },
    {
      event_type: 'late-join-call-taken',
      call_id: IDS.call1,
      apartment_id: IDS.apartment1,
      building_id: IDS.building1,
      description: 'Device late-joined but call already accepted',
    },
  ]);
});

test('PostgreSQL-backed all-resident decline marks the call rejected and writes audit state', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentRingFixture(harness, { firebaseUid: 'firebase-user-1' });

  const serverHarness = createPostgresWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', 'connection-3', IDS.call1],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const homeOneWs = new FakeWebSocket('home-1');
  const homeTwoWs = new FakeWebSocket('home-2');
  serverHarness.handleConnection(intercomWs);
  serverHarness.handleConnection(homeOneWs);
  serverHarness.handleConnection(homeTwoWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await homeOneWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
  await homeTwoWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
  await flushAsync(3);

  await homeOneWs.emitMessage({ type: 'decline' });
  await flushAsync(2);
  await homeTwoWs.emitMessage({ type: 'decline' });
  await flushAsync(4);

  const callRows = await harness.query(
    `SELECT status FROM calls WHERE id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(callRows.rows, [{ status: 'rejected' }]);

  const auditRows = await harness.query(
    `SELECT event_type, call_id, description
     FROM audit_logs
     WHERE call_id = $1
     ORDER BY created_at ASC`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, [
    {
      event_type: 'call-initiated',
      call_id: IDS.call1,
      description: 'Ring started by intercom',
    },
    {
      event_type: 'call-rejected',
      call_id: IDS.call1,
      description: 'All residents declined',
    },
  ]);

  assert.deepEqual(serverHarness.cancelRetryCalls, [IDS.call1]);
  assert.equal(serverHarness.connectionStateMock.activeCall.get(IDS.intercom1), null);
  assert.equal(intercomWs.sentMessages.some((message) => message.type === 'decline'), true);
});

test('PostgreSQL-backed accepted-home disconnect ends the call and writes audit state', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentRingFixture(harness, { firebaseUid: 'firebase-user-1' });

  const serverHarness = createPostgresWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', IDS.call1],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const homeWs = new FakeWebSocket('home');
  serverHarness.handleConnection(intercomWs);
  serverHarness.handleConnection(homeWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await homeWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
  await flushAsync(3);

  await homeWs.emitMessage({ type: 'accept', callId: IDS.call1, userId: IDS.residentUser });
  await flushAsync(4);

  await homeWs.emitClose();
  await flushAsync(4);

  const callRows = await harness.query(
    `SELECT status, ended_at IS NOT NULL AS ended
     FROM calls
     WHERE id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(callRows.rows, [{ status: 'ended', ended: true }]);

  const auditRows = await harness.query(
    `SELECT event_type, call_id, description
     FROM audit_logs
     WHERE call_id = $1
     ORDER BY created_at ASC`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, [
    {
      event_type: 'call-initiated',
      call_id: IDS.call1,
      description: 'Ring started by intercom',
    },
    {
      event_type: 'call-accepted',
      call_id: IDS.call1,
      description: 'Call accepted by resident',
    },
    {
      event_type: 'call-ended',
      call_id: IDS.call1,
      description: 'Call ended by home disconnect',
    },
  ]);

  assert.equal(serverHarness.connectionStateMock.activeCall.get(IDS.intercom1), null);
  assert.deepEqual(intercomWs.sentMessages.at(-1), { type: 'peer-disconnected', role: 'home' });
});

test('PostgreSQL-backed max call duration timeout ends the accepted call and writes audit state', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentRingFixture(harness, { firebaseUid: 'firebase-user-1' });

  await withFakeTimers(async ({ timers, fireTimer }) => {
    const serverHarness = createPostgresWsHandlerHarness({
      uuidValues: ['connection-1', 'connection-2', IDS.call1],
    });

    const intercomWs = new FakeWebSocket('intercom');
    const homeWs = new FakeWebSocket('home');
    serverHarness.handleConnection(intercomWs);
    serverHarness.handleConnection(homeWs);

    await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
    await homeWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
    await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
    await flushAsync(3);

    await homeWs.emitMessage({ type: 'accept', callId: IDS.call1, userId: IDS.residentUser });
    await flushAsync(4);

    assert.ok(timers.some((timer) => timer.delay === 60000));

    await fireTimer(60000);

    const callRows = await harness.query(
      `SELECT status, ended_at IS NOT NULL AS ended
       FROM calls
       WHERE id = $1`,
      [IDS.call1]
    );
    assert.deepEqual(callRows.rows, [{ status: 'ended', ended: true }]);

    const auditRows = await harness.query(
      `SELECT event_type, call_id, description
       FROM audit_logs
       WHERE call_id = $1
       ORDER BY created_at ASC`,
      [IDS.call1]
    );
    assert.deepEqual(auditRows.rows, [
      {
        event_type: 'call-initiated',
        call_id: IDS.call1,
        description: 'Ring started by intercom',
      },
      {
        event_type: 'call-accepted',
        call_id: IDS.call1,
        description: 'Call accepted by resident',
      },
      {
        event_type: 'call-ended',
        call_id: IDS.call1,
        description: 'Call ended by max duration timeout',
      },
    ]);

    assert.equal(serverHarness.connectionStateMock.activeCall.get(IDS.intercom1), null);
    assert.deepEqual(serverHarness.cancelRetryCalls, [IDS.call1]);
    assert.deepEqual(intercomWs.sentMessages.at(-1), { type: 'hangup', reason: 'timeout', callId: IDS.call1 });
    assert.equal(homeWs.sentMessages.some((message) => message.type === 'hangup' && message.reason === 'timeout' && message.callId === IDS.call1), true);
  });
});

test('PostgreSQL-backed home hangup ends the accepted call and writes audit state', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentRingFixture(harness, { firebaseUid: 'firebase-user-1' });

  const serverHarness = createPostgresWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', IDS.call1],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const homeWs = new FakeWebSocket('home');
  serverHarness.handleConnection(intercomWs);
  serverHarness.handleConnection(homeWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await homeWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
  await flushAsync(3);

  await homeWs.emitMessage({ type: 'accept', callId: IDS.call1, userId: IDS.residentUser });
  await flushAsync(4);
  await homeWs.emitMessage({ type: 'hangup', callId: IDS.call1 });
  await flushAsync(4);

  const callRows = await harness.query(
    `SELECT status, ended_at IS NOT NULL AS ended
     FROM calls
     WHERE id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(callRows.rows, [{ status: 'ended', ended: true }]);

  const auditRows = await harness.query(
    `SELECT event_type, call_id, description
     FROM audit_logs
     WHERE call_id = $1
     ORDER BY created_at ASC`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, [
    {
      event_type: 'call-initiated',
      call_id: IDS.call1,
      description: 'Ring started by intercom',
    },
    {
      event_type: 'call-accepted',
      call_id: IDS.call1,
      description: 'Call accepted by resident',
    },
    {
      event_type: 'call-ended',
      call_id: IDS.call1,
      description: 'Call ended by home hangup',
    },
  ]);

  assert.equal(serverHarness.connectionStateMock.activeCall.get(IDS.intercom1), null);
  assert.deepEqual(serverHarness.cancelRetryCalls, [IDS.call1, IDS.call1]);
  assert.deepEqual(intercomWs.sentMessages.at(-1), { type: 'hangup' });
});

test('PostgreSQL-backed open-door ends the accepted call and writes audit state', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentRingFixture(harness, { firebaseUid: 'firebase-user-1' });

  const serverHarness = createPostgresWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', IDS.call1],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const homeWs = new FakeWebSocket('home');
  serverHarness.handleConnection(intercomWs);
  serverHarness.handleConnection(homeWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await homeWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
  await flushAsync(3);

  await homeWs.emitMessage({ type: 'accept', callId: IDS.call1, userId: IDS.residentUser });
  await flushAsync(4);
  await homeWs.emitMessage({ type: 'open-door', callId: IDS.call1 });
  await flushAsync(4);

  const callRows = await harness.query(
    `SELECT status, ended_at IS NOT NULL AS ended
     FROM calls
     WHERE id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(callRows.rows, [{ status: 'ended', ended: true }]);

  const auditRows = await harness.query(
    `SELECT event_type, call_id, description
     FROM audit_logs
     WHERE call_id = $1
     ORDER BY created_at ASC`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, [
    {
      event_type: 'call-initiated',
      call_id: IDS.call1,
      description: 'Ring started by intercom',
    },
    {
      event_type: 'call-accepted',
      call_id: IDS.call1,
      description: 'Call accepted by resident',
    },
    {
      event_type: 'call-ended',
      call_id: IDS.call1,
      description: 'Call ended after door open',
    },
  ]);

  assert.equal(serverHarness.connectionStateMock.activeCall.get(IDS.intercom1), null);
  assert.deepEqual(serverHarness.cancelRetryCalls, [IDS.call1, IDS.call1]);
  assert.deepEqual(intercomWs.sentMessages.at(-1), { type: 'open-door' });
});

test('PostgreSQL-backed intercom hangup ends the accepted call and writes audit state', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentRingFixture(harness, { firebaseUid: 'firebase-user-1' });

  const serverHarness = createPostgresWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', IDS.call1],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const homeWs = new FakeWebSocket('home');
  serverHarness.handleConnection(intercomWs);
  serverHarness.handleConnection(homeWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await homeWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
  await flushAsync(3);

  await homeWs.emitMessage({ type: 'accept', callId: IDS.call1, userId: IDS.residentUser });
  await flushAsync(4);
  await intercomWs.emitMessage({ type: 'hangup', callId: IDS.call1 });
  await flushAsync(4);

  const callRows = await harness.query(
    `SELECT status, ended_at IS NOT NULL AS ended
     FROM calls
     WHERE id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(callRows.rows, [{ status: 'ended', ended: true }]);

  const auditRows = await harness.query(
    `SELECT event_type, call_id, description
     FROM audit_logs
     WHERE call_id = $1
     ORDER BY created_at ASC`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, [
    {
      event_type: 'call-initiated',
      call_id: IDS.call1,
      description: 'Ring started by intercom',
    },
    {
      event_type: 'call-accepted',
      call_id: IDS.call1,
      description: 'Call accepted by resident',
    },
    {
      event_type: 'call-ended',
      call_id: IDS.call1,
      description: 'Call ended by intercom hangup',
    },
  ]);

  assert.equal(serverHarness.connectionStateMock.activeCall.get(IDS.intercom1), null);
  assert.deepEqual(serverHarness.cancelRetryCalls, [IDS.call1, IDS.call1]);
  assert.equal(homeWs.sentMessages.some((message) => message.type === 'hangup' && message.callId === IDS.call1), true);
});

test('PostgreSQL-backed intercom disconnect ends the accepted call, updates intercom presence, and writes audit state', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentRingFixture(harness, { firebaseUid: 'firebase-user-1' });

  const serverHarness = createPostgresWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', IDS.call1],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const homeWs = new FakeWebSocket('home');
  serverHarness.handleConnection(intercomWs);
  serverHarness.handleConnection(homeWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await homeWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
  await flushAsync(3);

  await homeWs.emitMessage({ type: 'accept', callId: IDS.call1, userId: IDS.residentUser });
  await flushAsync(4);
  await intercomWs.emitClose();
  await flushAsync(4);

  const callRows = await harness.query(
    `SELECT status, ended_at IS NOT NULL AS ended
     FROM calls
     WHERE id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(callRows.rows, [{ status: 'ended', ended: true }]);

  const auditRows = await harness.query(
    `SELECT event_type, call_id, description
     FROM audit_logs
     WHERE call_id = $1
     ORDER BY created_at ASC`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, [
    {
      event_type: 'call-initiated',
      call_id: IDS.call1,
      description: 'Ring started by intercom',
    },
    {
      event_type: 'call-accepted',
      call_id: IDS.call1,
      description: 'Call accepted by resident',
    },
    {
      event_type: 'call-ended',
      call_id: IDS.call1,
      description: 'Call ended by intercom disconnect',
    },
  ]);

  const intercomRows = await harness.query(
    `SELECT status FROM intercoms WHERE id = $1`,
    [IDS.intercom1]
  );
  assert.deepEqual(intercomRows.rows, [{ status: 'disconnected' }]);

  assert.equal(serverHarness.connectionStateMock.activeCall.get(IDS.intercom1), null);
  assert.deepEqual(serverHarness.cancelRetryCalls, [IDS.call1, IDS.call1]);
  assert.deepEqual(homeWs.sentMessages.at(-1), { type: 'peer-disconnected', role: 'intercom' });
});

test('PostgreSQL-backed ringing-home disconnect marks the call rejected and writes disconnect-decline audit state', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentRingFixture(harness, { firebaseUid: 'firebase-user-1' });

  const serverHarness = createPostgresWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', IDS.call1],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const homeWs = new FakeWebSocket('home');
  serverHarness.handleConnection(intercomWs);
  serverHarness.handleConnection(homeWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await homeWs.emitMessage({ type: 'register', role: 'home', apartmentId: IDS.apartment1, token: 'resident-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
  await flushAsync(3);

  await homeWs.emitClose();
  await flushAsync(4);

  const callRows = await harness.query(
    `SELECT status FROM calls WHERE id = $1`,
    [IDS.call1]
  );
  assert.deepEqual(callRows.rows, [{ status: 'rejected' }]);

  const auditRows = await harness.query(
    `SELECT event_type, call_id, description
     FROM audit_logs
     WHERE call_id = $1
     ORDER BY created_at ASC`,
    [IDS.call1]
  );
  assert.deepEqual(auditRows.rows, [
    {
      event_type: 'call-initiated',
      call_id: IDS.call1,
      description: 'Ring started by intercom',
    },
    {
      event_type: 'call-rejected',
      call_id: IDS.call1,
      description: 'All residents declined/disconnected',
    },
  ]);

  assert.equal(serverHarness.connectionStateMock.activeCall.get(IDS.intercom1), null);
  assert.equal(intercomWs.sentMessages.some((message) => message.type === 'decline'), true);
});

test('PostgreSQL-backed ring skips all-sleeping apartments without creating a call row', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedSleepModeRingFixture(harness, { allSleeping: true });

  const serverHarness = createPostgresWsHandlerHarness({
    uuidValues: ['connection-1'],
  });

  const intercomWs = new FakeWebSocket('intercom');
  serverHarness.handleConnection(intercomWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
  await flushAsync(4);

  assert.deepEqual(intercomWs.sentMessages.at(-1), {
    type: 'apartment-unavailable',
    reason: 'all-residents-sleeping',
    apartmentId: IDS.apartment1,
  });

  const callRows = await harness.query(
    `SELECT id FROM calls`
  );
  assert.deepEqual(callRows.rows, []);

  const auditRows = await harness.query(
    `SELECT event_type, building_id, apartment_id, intercom_id, description
     FROM audit_logs`,
  );
  assert.deepEqual(auditRows.rows, [
    {
      event_type: 'ring-skipped-sleep-mode',
      building_id: IDS.building1,
      apartment_id: IDS.apartment1,
      intercom_id: IDS.intercom1,
      description: 'Ring skipped — all residents have sleep mode enabled',
    },
  ]);

  assert.deepEqual(serverHarness.retryCalls, []);
});

test('PostgreSQL-backed ring filters sleeping residents and only targets awake device tokens', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedSleepModeRingFixture(harness, { allSleeping: false });
  await harness.query(
    `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, updated_at)
     VALUES ($1, $2, 'sleeping-token', 'fcm', 'android', NOW()),
            ($1, $3, 'awake-token', 'fcm', 'android', NOW())`,
    [IDS.apartment1, IDS.residentUser, IDS.residentUser2]
  );

  const serverHarness = createPostgresWsHandlerHarness({
    uuidValues: ['connection-1', IDS.call1],
  });

  const intercomWs = new FakeWebSocket('intercom');
  serverHarness.handleConnection(intercomWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: IDS.apartment1 });
  await flushAsync(6);

  const attemptRows = await harness.query(
    `SELECT device_token, user_id, delivery_state
     FROM call_delivery_attempts
     WHERE call_id = $1
     ORDER BY device_token ASC`,
    [IDS.call1]
  );
  assert.deepEqual(attemptRows.rows, [
    {
      device_token: 'awake-token',
      user_id: IDS.residentUser2,
      delivery_state: 'push-sent',
    },
  ]);

  const auditRows = await harness.query(
    `SELECT event_type, description
     FROM audit_logs
     ORDER BY created_at ASC`
  );
  assert.equal(auditRows.some((row) => row.event_type === 'ring-skipped-sleep-mode' && row.description === 'Ring delivery filtered — 1 resident(s) in sleep mode'), true);
  assert.equal(auditRows.some((row) => row.event_type === 'call-initiated'), true);

  assert.deepEqual(serverHarness.fcmSendCalls.map((message) => message.token), ['awake-token']);
  assert.deepEqual(serverHarness.retryCalls, [{ callId: IDS.call1, ringTimeoutSec: 30 }]);
});