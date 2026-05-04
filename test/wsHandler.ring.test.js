const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const ringTimeoutModule = require('../src/ringTimeout');

function requireWithMocks(modulePath, mocks) {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

class FakeWebSocket {
  constructor() {
    this.handlers = new Map();
    this.sentMessages = [];
    this.readyState = 1;
    this.isAlive = false;
    this.closed = false;
  }

  on(eventName, handler) {
    this.handlers.set(eventName, handler);
  }

  send(message) {
    this.sentMessages.push(JSON.parse(message));
  }

  close() {
    this.closed = true;
  }

  async emitMessage(message) {
    const handler = this.handlers.get('message');
    assert.ok(handler, 'message handler must be registered');
    await handler(JSON.stringify(message));
  }
}

test('resolveRingTimeoutSec prefers building timeout, then global, then default', async () => {
  const buildingTimeout = await ringTimeoutModule.resolveRingTimeoutSec(async (sql) => {
    if (sql.includes('SELECT b.no_answer_timeout')) {
      return { rows: [{ no_answer_timeout: '45' }] };
    }
    throw new Error('global timeout query should not run when building timeout exists');
  }, 'apt-1');

  assert.equal(buildingTimeout, 45);
  assert.equal(ringTimeoutModule.getRingTimeoutMs(buildingTimeout), 45000);

  const globalTimeout = await ringTimeoutModule.resolveRingTimeoutSec(async (sql) => {
    if (sql.includes('SELECT b.no_answer_timeout')) {
      return { rows: [{ no_answer_timeout: null }] };
    }
    if (sql.includes("SELECT value FROM global_settings")) {
      return { rows: [{ value: '22' }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, 'apt-2');

  assert.equal(globalTimeout, 22);

  const fallbackTimeout = await ringTimeoutModule.resolveRingTimeoutSec(async () => {
    throw new Error('db unavailable');
  }, 'apt-3');

  assert.equal(fallbackTimeout, ringTimeoutModule.DEFAULT_RING_TIMEOUT_SEC);
});

test('ring handler resolves timeout before insert and reuses it consistently', async () => {
  const queryCalls = [];
  const callInsertParams = [];
  const pendingRingCalls = [];
  const retryCalls = [];
  const fcmMessages = [];
  const apartmentMessages = [];

  const connectionStateMock = {
    clients: {},
    fcmTokens: new Map(),
    voipTokens: new Map(),
    addIntercom(deviceId, buildingId, ws) {
      this._intercom = { deviceId, buildingId, ws };
    },
    removeIntercom() {},
    getIntercom(deviceId) {
      return this._intercom && this._intercom.deviceId === deviceId ? this._intercom : null;
    },
    getIntercomForBuilding(buildingId) {
      return this._intercom && this._intercom.buildingId === buildingId ? this._intercom : null;
    },
    addHomeClient() {},
    removeHomeClient() {},
    getHomeClients() {
      return [];
    },
    sendToApartment(apartmentId, payload) {
      apartmentMessages.push({ apartmentId, payload });
      return 0;
    },
    activeCall: {
      _calls: new Map(),
      get(deviceId) {
        return this._calls.get(deviceId) || null;
      },
      start(deviceId, apartmentId, type, callId) {
        this._calls.set(deviceId, { apartmentId, type, callId, acceptedBy: null });
      },
      clear(deviceId) {
        this._calls.delete(deviceId);
      },
      getByApartment(apartmentId) {
        for (const [deviceId, call] of this._calls.entries()) {
          if (call.apartmentId === apartmentId) {
            return { ...call, intercomDeviceId: deviceId };
          }
        }
        return null;
      },
    },
    activeCalls: new Map(),
    setPendingRing(apartmentId, intercomDeviceId, timeoutMs, onExpired) {
      pendingRingCalls.push({ apartmentId, intercomDeviceId, timeoutMs, onExpiredType: typeof onExpired });
    },
    clearPendingRing() {},
    isPendingRing() {
      return false;
    },
    getPendingRing() {
      return null;
    },
    clearAcceptTimer() {},
  };

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
    './db': {
      async query(sql, params = []) {
        queryCalls.push({ sql, params });

        if (sql.includes("UPDATE intercoms SET status = 'connected'")) {
          return { rows: [] };
        }
        if (sql.includes('SELECT u.id, u.sleep_mode')) {
          return { rows: [{ id: 'user-1', sleep_mode: false }] };
        }
        if (sql.includes('SELECT b.no_answer_timeout')) {
          return { rows: [{ no_answer_timeout: 45 }] };
        }
        if (sql.includes("SELECT value FROM global_settings")) {
          return { rows: [{ value: '30' }] };
        }
        if (sql.includes('INSERT INTO calls')) {
          callInsertParams.push(params);
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO audit_logs')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT token, token_type, platform, user_id FROM device_tokens')) {
          return {
            rows: [{ token: 'fcm-token-1', token_type: 'fcm', platform: 'android', user_id: 'user-1' }],
          };
        }
        if (sql.includes('INSERT INTO call_delivery_attempts')) {
          return { rows: [] };
        }
        if (sql.includes('UPDATE call_delivery_attempts')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT * FROM device_health')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT 1 FROM call_delivery_acks')) {
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO device_health')) {
          return { rows: [] };
        }

        throw new Error(`Unexpected SQL: ${sql}`);
      },
    },
    './apnsService': {
      isAPNsReady() {
        return false;
      },
      async sendVoipPush() {
        return { success: true };
      },
    },
    './retryOrchestrator': {
      startRetries(callId, ringTimeoutSec) {
        retryCalls.push({ callId, ringTimeoutSec });
      },
      cancelRetries() {},
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
            fcmMessages.push(message);
          },
        };
      },
    },
    uuid: {
      v4: (() => {
        let count = 0;
        return () => {
          count += 1;
          return count === 1 ? 'connection-1' : 'call-1';
        };
      })(),
    },
  });

  const ws = new FakeWebSocket();
  handleConnection(ws);

  await ws.emitMessage({ type: 'register', role: 'intercom', token: 'valid-token' });
  await ws.emitMessage({ type: 'ring', apartmentId: 'apt-1' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(callInsertParams.length, 1, 'ring should insert one call row');
  assert.deepEqual(callInsertParams[0], ['call-1', 'building-1', 'apt-1', 'intercom-1', 45]);

  assert.deepEqual(pendingRingCalls, [{
    apartmentId: 'apt-1',
    intercomDeviceId: 'intercom-1',
    timeoutMs: 45000,
    onExpiredType: 'function',
  }]);

  assert.equal(fcmMessages.length, 1, 'ring should send one FCM push');
  assert.equal(fcmMessages[0].android.ttl, 45000);
  assert.deepEqual(retryCalls, [{ callId: 'call-1', ringTimeoutSec: 45 }]);
  assert.deepEqual(apartmentMessages, [{ apartmentId: 'apt-1', payload: { type: 'ring', callId: 'call-1' } }]);

  const timeoutQueryIndex = queryCalls.findIndex(({ sql }) => sql.includes('SELECT b.no_answer_timeout'));
  const insertQueryIndex = queryCalls.findIndex(({ sql }) => sql.includes('INSERT INTO calls'));
  assert.notEqual(timeoutQueryIndex, -1, 'timeout query should run');
  assert.notEqual(insertQueryIndex, -1, 'call insert query should run');
  assert.ok(timeoutQueryIndex < insertQueryIndex, 'timeout must be resolved before inserting the call row');
});