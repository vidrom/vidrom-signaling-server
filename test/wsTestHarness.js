const assert = require('node:assert/strict');
const Module = require('module');

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
  constructor(name = 'ws') {
    this.name = name;
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
    this.sentMessages.push(typeof message === 'string' ? JSON.parse(message) : message);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  async emitMessage(message) {
    const handler = this.handlers.get('message');
    assert.ok(handler, 'message handler must be registered');
    await handler(JSON.stringify(message));
  }
}

function createConnectionStateMock() {
  const intercoms = new Map();
  const homeClients = new Map();
  const activeCalls = new Map();
  const pendingRings = new Map();
  const clearedAcceptTimers = [];

  function getHomeClients(apartmentId) {
    return homeClients.get(apartmentId) || new Map();
  }

  const activeCall = {
    start(intercomDeviceId, apartmentId, type = 'call', callId = null) {
      activeCalls.set(intercomDeviceId, {
        apartmentId,
        type,
        callId,
        acceptedBy: null,
        acceptedWs: null,
        declinedBy: new Set(),
        httpAcceptedBy: null,
      });
    },
    get(intercomDeviceId) {
      return activeCalls.get(intercomDeviceId) || null;
    },
    getByApartment(apartmentId) {
      for (const [intercomDeviceId, call] of activeCalls.entries()) {
        if (call.apartmentId === apartmentId) {
          return { ...call, intercomDeviceId };
        }
      }
      return null;
    },
    accept(intercomDeviceId, connId, ws) {
      const call = activeCalls.get(intercomDeviceId);
      if (!call || call.acceptedBy) return false;
      call.acceptedBy = connId;
      call.acceptedWs = ws;
      return true;
    },
    httpAccept(intercomDeviceId, userId) {
      const call = activeCalls.get(intercomDeviceId);
      if (!call || call.acceptedBy) return false;
      call.acceptedBy = `http:${userId}`;
      call.httpAcceptedBy = userId;
      return true;
    },
    decline(intercomDeviceId, connId) {
      const call = activeCalls.get(intercomDeviceId);
      if (call) call.declinedBy.add(connId);
    },
    clear(intercomDeviceId) {
      activeCalls.delete(intercomDeviceId);
    },
  };

  return {
    clients: { intercom: null, home: null },
    fcmTokens: new Map(),
    voipTokens: new Map(),
    intercoms,
    homeClients,
    activeCalls,
    clearedAcceptTimers,
    addIntercom(deviceId, buildingId, ws) {
      intercoms.set(deviceId, { deviceId, buildingId, ws });
    },
    removeIntercom(deviceId) {
      intercoms.delete(deviceId);
    },
    getIntercom(deviceId) {
      return intercoms.get(deviceId) || null;
    },
    getIntercomForBuilding(buildingId) {
      for (const [deviceId, entry] of intercoms.entries()) {
        if (entry.buildingId === buildingId && entry.ws.readyState === 1) {
          return { deviceId, ...entry };
        }
      }
      return null;
    },
    addHomeClient(apartmentId, connId, ws, buildingId) {
      if (!homeClients.has(apartmentId)) {
        homeClients.set(apartmentId, new Map());
      }
      homeClients.get(apartmentId).set(connId, { ws, buildingId });
    },
    removeHomeClient(apartmentId, connId) {
      const apt = homeClients.get(apartmentId);
      if (!apt) return;
      apt.delete(connId);
      if (apt.size === 0) homeClients.delete(apartmentId);
    },
    getHomeClients,
    sendToApartment(apartmentId, payload) {
      const clients = getHomeClients(apartmentId);
      let sent = 0;
      for (const [, entry] of clients.entries()) {
        if (entry.ws.readyState === 1) {
          entry.ws.send(JSON.stringify(payload));
          sent += 1;
        }
      }
      return sent;
    },
    activeCall,
    setPendingRing(apartmentId, intercomDeviceId, timeoutMs, onExpired) {
      pendingRings.set(apartmentId, { intercomDeviceId, timeoutMs, onExpired });
    },
    clearPendingRing(apartmentId) {
      pendingRings.delete(apartmentId);
    },
    isPendingRing(apartmentId) {
      return pendingRings.has(apartmentId);
    },
    getPendingRing(apartmentId) {
      return pendingRings.get(apartmentId) || null;
    },
    async triggerPendingRingExpiry(apartmentId) {
      const entry = pendingRings.get(apartmentId);
      if (!entry) return false;
      pendingRings.delete(apartmentId);
      const call = activeCall.get(entry.intercomDeviceId);
      if (call && entry.onExpired) {
        await entry.onExpired(call);
      }
      if (call && call.apartmentId === apartmentId && !call.acceptedBy) {
        activeCall.clear(entry.intercomDeviceId);
      }
      return true;
    },
    startAcceptTimer() {},
    clearAcceptTimer(callId) {
      clearedAcceptTimers.push(callId);
    },
  };
}

async function flushAsync(times = 1) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

module.exports = {
  FakeWebSocket,
  createConnectionStateMock,
  flushAsync,
  requireWithMocks,
};