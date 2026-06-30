const assert = require('node:assert/strict');

const signalingContract = require('../../../test/signalingContract');
const {
  FakeWebSocket,
  createConnectionStateMock,
  flushAsync,
  requireWithMocks,
} = require('../wsTestHarness');

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
    if (sql.includes("UPDATE calls SET status = '")) return { rows: [] };
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

function createServerHarness({
  uuidValues,
  queryOptions,
  isAPNsReady = false,
  sendVoipPushImpl = async () => ({ success: true }),
  fcmSendImpl = async () => undefined,
} = {}) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const scheduledTimeouts = new Map();
  let nextTimeoutId = 1;

  global.setTimeout = (fn, ms, ...args) => {
    const id = nextTimeoutId;
    nextTimeoutId += 1;
    scheduledTimeouts.set(id, { fn, ms, args });
    return id;
  };

  global.clearTimeout = (id) => {
    scheduledTimeouts.delete(id);
  };

  const connectionStateMock = createConnectionStateMock();
  const retryCalls = [];
  const cancelRetryCalls = [];
  const deleteCalls = [];
  const voipPushCalls = [];
  const fcmSendCalls = [];
  const { query, queryCalls } = createQueryMock({ ...queryOptions, deleteCalls });

  const { handleConnection } = requireWithMocks('../src/wsHandler', {
    './auth': {
      verifyToken() {
        return { deviceId: 'intercom-1', buildingId: 'building-1', role: 'intercom' };
      },
      async authenticateResidentToken() {
        return {
          userId: 'user-1',
          apartmentIds: ['apt-1'],
          primaryApartmentId: 'apt-1',
          buildingIds: ['building-1'],
          apartments: [{ apartmentId: 'apt-1', buildingId: 'building-1' }],
        };
      },
      residentHasApartmentAccess(context, apartmentId) {
        return context.apartmentIds.includes(apartmentId);
      },
    },
    './devices': {
      async getDevice() {
        return { id: 'intercom-1', buildingId: 'building-1', status: 'active' };
      },
    },
    './connectionState': connectionStateMock,
    './db': { query },
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
    uuid: createUuidMock(uuidValues || []),
  });

  return {
    handleConnection,
    connectionStateMock,
    queryCalls,
    retryCalls,
    cancelRetryCalls,
    deleteCalls,
    voipPushCalls,
    fcmSendCalls,
    dispose() {
      scheduledTimeouts.clear();
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    },
  };
}

class ScenarioClient {
  constructor(role, ws) {
    this.role = role;
    this.ws = ws;
  }

  get sentMessages() {
    return this.ws.sentMessages;
  }

  get lastMessage() {
    return this.ws.sentMessages.at(-1) || null;
  }

  async registerIntercom(token = 'valid-token') {
    assert.equal(this.role, 'intercom');
    await this.ws.emitMessage({ type: 'register', role: 'intercom', token });
  }

  async registerHome({ apartmentId = 'apt-1', token = 'resident-token' } = {}) {
    assert.equal(this.role, 'home');
    await this.ws.emitMessage({ type: 'register', role: 'home', apartmentId, token });
  }

  async ring(apartmentId = 'apt-1') {
    assert.equal(this.role, 'intercom');
    await this.ws.emitMessage(signalingContract.intercomToServer.ring({ apartmentId }));
  }

  async accept({ callId = 'call-1', userId = 'user-1' } = {}) {
    assert.equal(this.role, 'home');
    await this.ws.emitMessage(signalingContract.homeToServer.accept({ callId, userId }));
  }

  async decline({ callId = 'call-1' } = {}) {
    assert.equal(this.role, 'home');
    await this.ws.emitMessage(signalingContract.homeToServer.decline({ callId }));
  }

  async offer() {
    await this.ws.emitMessage(signalingContract.homeToServer.offer());
  }

  async openDoor() {
    assert.equal(this.role, 'home');
    await this.ws.emitMessage(signalingContract.homeToServer.openDoor());
  }

  async hangup({ callId = 'call-1' } = {}) {
    if (this.role === 'home') {
      await this.ws.emitMessage(signalingContract.homeToServer.hangup({ callId }));
      return;
    }
    await this.ws.emitMessage(signalingContract.intercomToServer.hangup());
  }

  async watch() {
    assert.equal(this.role, 'home');
    await this.ws.emitMessage(signalingContract.homeToServer.watch());
  }

  async watchEnd() {
    assert.equal(this.role, 'home');
    await this.ws.emitMessage(signalingContract.homeToServer.watchEnd());
  }

  async disconnect() {
    this.ws.close();
    const closeHandler = this.ws.handlers.get('close');
    if (closeHandler) {
      await closeHandler();
      await flushAsync();
    }
  }
}

function createScenarioRunner(options = {}) {
  const server = createServerHarness(options);

  function createIntercom(name = 'intercom') {
    const ws = new FakeWebSocket(name);
    server.handleConnection(ws);
    return new ScenarioClient('intercom', ws);
  }

  function createHome(name = 'home') {
    const ws = new FakeWebSocket(name);
    server.handleConnection(ws);
    return new ScenarioClient('home', ws);
  }

  return {
    createIntercom,
    createHome,
    flushAsync,
    server,
    dispose() {
      server.dispose();
    },
    getActiveCall(intercomDeviceId = 'intercom-1') {
      return server.connectionStateMock.activeCall.get(intercomDeviceId);
    },
    getPendingRing(apartmentId = 'apt-1') {
      return server.connectionStateMock.getPendingRing(apartmentId);
    },
    async triggerPendingRingExpiry(apartmentId = 'apt-1') {
      return server.connectionStateMock.triggerPendingRingExpiry(apartmentId);
    },
    seedHttpAccept(intercomDeviceId = 'intercom-1', userId = 'user-1') {
      return server.connectionStateMock.activeCall.httpAccept(intercomDeviceId, userId);
    },
    getVoipPushCalls() {
      return server.voipPushCalls;
    },
    getFcmSendCalls() {
      return server.fcmSendCalls;
    },
    getDeleteCalls() {
      return server.deleteCalls;
    },
  };
}

module.exports = {
  createScenarioRunner,
};