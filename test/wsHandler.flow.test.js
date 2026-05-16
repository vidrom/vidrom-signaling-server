const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FakeWebSocket,
  createConnectionStateMock,
  flushAsync,
  requireWithMocks,
} = require('./wsTestHarness');

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

function createQueryMock({
  deleteCalls = [],
  callRows = [],
  deviceTokenRows = [],
  extraHandler = null,
} = {}) {
  const queryCalls = [];

  async function query(sql, params = []) {
    queryCalls.push({ sql, params });

    if (sql.includes("UPDATE intercoms SET status = 'connected'")) return { rows: [] };
    if (sql.includes('SELECT building_id FROM apartments')) return { rows: [{ building_id: 'building-1' }] };
    if (sql.includes('SELECT u.id, u.sleep_mode')) return { rows: [{ id: 'user-1', sleep_mode: false }] };
    if (sql.includes('SELECT b.no_answer_timeout')) return { rows: [{ no_answer_timeout: 30 }] };
    if (sql.includes("SELECT value FROM global_settings")) return { rows: [{ value: '30' }] };
    if (sql.includes('INSERT INTO calls')) return { rows: [] };
    if (sql.includes('INSERT INTO audit_logs')) return { rows: [] };
    if (sql.includes('UPDATE calls SET status =')) return { rows: [] };
    if (sql.includes('SELECT token, token_type, platform, user_id FROM device_tokens')) {
      return { rows: deviceTokenRows };
    }
    if (sql.includes('SELECT token, token_type FROM device_tokens')) {
      return { rows: callRows };
    }
    if (sql.includes('INSERT INTO call_delivery_attempts')) return { rows: [] };
    if (sql.includes('UPDATE call_delivery_attempts')) return { rows: [] };
    if (sql.includes('SELECT * FROM device_health')) return { rows: [] };
    if (sql.includes('SELECT 1 FROM call_delivery_acks')) return { rows: [] };
    if (sql.includes('INSERT INTO device_health')) return { rows: [] };
    if (sql.includes('DELETE FROM device_tokens')) {
      deleteCalls.push({ sql, params });
      return { rows: [] };
    }

    if (extraHandler) {
      const result = await extraHandler(sql, params, queryCalls);
      if (result !== undefined) return result;
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  }

  return { query, queryCalls };
}

function createWsHandlerHarness({
  uuidValues,
  queryOptions,
  isAPNsReady = false,
  sendVoipPushImpl = async () => ({ success: true }),
  fcmSendImpl = async () => undefined,
} = {}) {
  const connectionStateMock = createConnectionStateMock();
  const retryCalls = [];
  const cancelRetryCalls = [];
  const deleteCalls = [];
  const { query, queryCalls } = createQueryMock({ ...queryOptions, deleteCalls });

  const { handleConnection } = requireWithMocks('../src/wsHandler', {
    './auth': {
      verifyToken() {
        return { deviceId: 'intercom-1', buildingId: 'building-1' };
      },
    },
    './devices': {
      async getDevice() {
        return { id: 'intercom-1', status: 'active' };
      },
    },
    './connectionState': connectionStateMock,
    './db': { query },
    './apnsService': {
      isAPNsReady() {
        return isAPNsReady;
      },
      async sendVoipPush(...args) {
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
            return fcmSendImpl(message);
          },
        };
      },
    },
    uuid: createUuidMock(uuidValues || []),
  });

  return {
    handleConnection,
    connectionStateMock,
    queryCalls,
    retryCalls,
    cancelRetryCalls,
    deleteCalls,
  };
}

test('ring -> accept -> offer -> hangup relays across the winning home client', async () => {
  const harness = createWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', 'call-1'],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const homeWs = new FakeWebSocket('home');
  harness.handleConnection(intercomWs);
  harness.handleConnection(homeWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await homeWs.emitMessage({ type: 'register', role: 'home', apartmentId: 'apt-1' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: 'apt-1' });
  await flushAsync(2);

  assert.deepEqual(homeWs.sentMessages.at(-1), {
    type: 'ring',
    callId: 'call-1',
  });

  await homeWs.emitMessage({ type: 'accept', userId: 'user-1' });
  await flushAsync(2);
  assert.deepEqual(intercomWs.sentMessages.at(-1), { type: 'accept', callId: 'call-1' });

  await homeWs.emitMessage({ type: 'offer', sdp: { type: 'offer', sdp: 'offer-sdp' } });
  await flushAsync();
  assert.deepEqual(intercomWs.sentMessages.at(-1), {
    type: 'offer',
    sdp: { type: 'offer', sdp: 'offer-sdp' },
  });

  await homeWs.emitMessage({ type: 'hangup', callId: 'call-1' });
  await flushAsync(2);
  assert.deepEqual(intercomWs.sentMessages.at(-1), { type: 'hangup' });
  assert.equal(harness.connectionStateMock.activeCall.get('intercom-1'), null);
  assert.deepEqual(harness.cancelRetryCalls, ['call-1', 'call-1']);
});

test('first accept wins and later acceptors receive call-taken', async () => {
  const harness = createWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', 'connection-3', 'call-1'],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const homeOneWs = new FakeWebSocket('home-1');
  const homeTwoWs = new FakeWebSocket('home-2');
  harness.handleConnection(intercomWs);
  harness.handleConnection(homeOneWs);
  harness.handleConnection(homeTwoWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await homeOneWs.emitMessage({ type: 'register', role: 'home', apartmentId: 'apt-1' });
  await homeTwoWs.emitMessage({ type: 'register', role: 'home', apartmentId: 'apt-1' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: 'apt-1' });
  await flushAsync(2);

  await homeOneWs.emitMessage({ type: 'accept', userId: 'user-1' });
  await flushAsync(2);
  assert.deepEqual(intercomWs.sentMessages.at(-1), { type: 'accept', callId: 'call-1' });
  assert.deepEqual(homeTwoWs.sentMessages.at(-1), { type: 'call-taken', callId: 'call-1' });

  const acceptCountBeforeSecondAccept = intercomWs.sentMessages.filter((message) => message.type === 'accept').length;
  await homeTwoWs.emitMessage({ type: 'accept', userId: 'user-2' });
  await flushAsync();
  assert.deepEqual(homeTwoWs.sentMessages.at(-1), { type: 'call-taken', callId: 'call-1' });
  const acceptCountAfterSecondAccept = intercomWs.sentMessages.filter((message) => message.type === 'accept').length;
  assert.equal(acceptCountAfterSecondAccept, acceptCountBeforeSecondAccept);

  await homeOneWs.emitMessage({ type: 'hangup', callId: 'call-1' });
  await flushAsync(2);
});

test('WS accept reconciles a prior HTTP accept from the same user', async () => {
  const harness = createWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', 'call-1'],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const homeWs = new FakeWebSocket('home');
  harness.handleConnection(intercomWs);
  harness.handleConnection(homeWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await homeWs.emitMessage({ type: 'register', role: 'home', apartmentId: 'apt-1' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: 'apt-1' });
  await flushAsync(2);

  assert.equal(harness.connectionStateMock.activeCall.httpAccept('intercom-1', 'user-1'), true);
  await homeWs.emitMessage({ type: 'accept', userId: 'user-1' });
  await flushAsync(2);

  const call = harness.connectionStateMock.activeCall.get('intercom-1');
  assert.equal(call.acceptedBy, 'connection-2');
  assert.equal(call.acceptedWs, homeWs);
  assert.deepEqual(harness.connectionStateMock.clearedAcceptTimers, ['call-1']);
  assert.equal(intercomWs.sentMessages.some((message) => message.type === 'accept'), false);

  await homeWs.emitMessage({ type: 'hangup', callId: 'call-1' });
  await flushAsync(2);
});

test('ring expiry marks the call unanswered and clears in-memory state', async () => {
  const harness = createWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2', 'call-1'],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const homeWs = new FakeWebSocket('home');
  harness.handleConnection(intercomWs);
  harness.handleConnection(homeWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await homeWs.emitMessage({ type: 'register', role: 'home', apartmentId: 'apt-1' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: 'apt-1' });
  await flushAsync(2);

  const expired = await harness.connectionStateMock.triggerPendingRingExpiry('apt-1');
  await flushAsync(2);

  assert.equal(expired, true);
  assert.equal(harness.connectionStateMock.activeCall.get('intercom-1'), null);
  assert.ok(harness.queryCalls.some(({ sql, params }) => sql.includes("UPDATE calls SET status = 'unanswered'") && params[0] === 'call-1'));
  assert.ok(harness.queryCalls.some(({ sql, params }) => sql.includes("'call-unanswered'") && params[3] === 'call-1'));
  assert.deepEqual(harness.cancelRetryCalls, ['call-1']);
});

test('watch start and watch end relay cleanly and clear watch state', async () => {
  const harness = createWsHandlerHarness({
    uuidValues: ['connection-1', 'connection-2'],
  });

  const intercomWs = new FakeWebSocket('intercom');
  const homeWs = new FakeWebSocket('home');
  harness.handleConnection(intercomWs);
  harness.handleConnection(homeWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await homeWs.emitMessage({ type: 'register', role: 'home', apartmentId: 'apt-1' });
  await homeWs.emitMessage({ type: 'watch' });
  await flushAsync();

  assert.deepEqual(intercomWs.sentMessages.at(-1), { type: 'watch' });
  const watchCall = harness.connectionStateMock.activeCall.get('intercom-1');
  assert.equal(watchCall.type, 'watch');
  assert.equal(watchCall.acceptedBy, 'connection-2');

  await homeWs.emitMessage({ type: 'watch-end' });
  await flushAsync();
  assert.deepEqual(intercomWs.sentMessages.at(-1), { type: 'watch-end' });
  assert.equal(harness.connectionStateMock.activeCall.get('intercom-1'), null);
});

test('known bad push errors clean up stale FCM and VoIP tokens', async () => {
  const harness = createWsHandlerHarness({
    uuidValues: ['connection-1', 'call-1'],
    queryOptions: {
      deviceTokenRows: [
        { token: 'dead-fcm', token_type: 'fcm', platform: 'android', user_id: 'user-1' },
        { token: 'dead-voip', token_type: 'voip', platform: 'ios', user_id: 'user-1' },
      ],
    },
    isAPNsReady: true,
    sendVoipPushImpl: async () => ({ success: false, reason: 'BadDeviceToken' }),
    fcmSendImpl: async () => {
      const err = new Error('gone');
      err.code = 'messaging/registration-token-not-registered';
      throw err;
    },
  });

  const intercomWs = new FakeWebSocket('intercom');
  harness.handleConnection(intercomWs);

  await intercomWs.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await intercomWs.emitMessage({ type: 'ring', apartmentId: 'apt-1' });
  await flushAsync(4);

  assert.ok(harness.deleteCalls.some(({ params }) => params[0] === 'dead-fcm'));
  assert.ok(harness.deleteCalls.some(({ params }) => params[0] === 'dead-voip'));
});