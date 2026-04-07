// Shared mutable state for connected clients, push tokens, and active calls
//
// Multi-tenant: supports multiple intercoms (one per building/device) and
// multiple home clients per apartment. Each intercom has its own active-call
// slot so buildings operate independently.
//
// When an intercom rings an apartment, ALL residents are notified.
// The first resident to accept gets the call (first-accept-wins).

// ---- Intercom clients: deviceId → { ws, buildingId } ----
const intercoms = new Map();

function addIntercom(deviceId, buildingId, ws) {
  intercoms.set(deviceId, { ws, buildingId });
}

function removeIntercom(deviceId) {
  intercoms.delete(deviceId);
}

function getIntercom(deviceId) {
  return intercoms.get(deviceId) || null;
}

// Look up the intercom WebSocket for a given building
function getIntercomForBuilding(buildingId) {
  for (const [deviceId, entry] of intercoms) {
    if (entry.buildingId === buildingId && entry.ws.readyState === 1) {
      return { deviceId, ...entry };
    }
  }
  return null;
}

// Legacy single-client fallback (kept for backward compat during transition)
const clients = {
  intercom: null,
  home: null,
};

// ---- Home clients: apartmentId → Map<connectionId, { ws, buildingId }> ----
const homeClients = new Map();

function addHomeClient(apartmentId, connId, ws, buildingId) {
  if (!homeClients.has(apartmentId)) {
    homeClients.set(apartmentId, new Map());
  }
  homeClients.get(apartmentId).set(connId, { ws, buildingId });
}

function removeHomeClient(apartmentId, connId) {
  const apt = homeClients.get(apartmentId);
  if (apt) {
    apt.delete(connId);
    if (apt.size === 0) homeClients.delete(apartmentId);
  }
}

function getHomeClients(apartmentId) {
  return homeClients.get(apartmentId) || new Map();
}

// Send a message to all connected home clients for an apartment
function sendToApartment(apartmentId, message) {
  const msg = typeof message === 'string' ? message : JSON.stringify(message);
  const apt = homeClients.get(apartmentId);
  if (!apt) return 0;
  let sent = 0;
  for (const [, entry] of apt) {
    if (entry.ws.readyState === 1) {
      entry.ws.send(msg);
      sent++;
    }
  }
  return sent;
}

// ---- Active call state: one active call per intercom (deviceId) ----
// activeCalls: deviceId → { apartmentId, type, acceptedBy, acceptedWs, declinedBy }
const activeCalls = new Map();

function startCall(intercomDeviceId, apartmentId, type = 'call', callId = null) {
  activeCalls.set(intercomDeviceId, {
    apartmentId,
    type,
    callId,
    acceptedBy: null,
    acceptedWs: null,
    declinedBy: new Set(),
  });
}

function getActiveCall(intercomDeviceId) {
  return activeCalls.get(intercomDeviceId) || null;
}

// Find the active call for a given apartment (needed for home→intercom routing)
function getActiveCallByApartment(apartmentId) {
  for (const [intercomDeviceId, call] of activeCalls) {
    if (call.apartmentId === apartmentId) {
      return { intercomDeviceId, ...call };
    }
  }
  return null;
}

function acceptCall(intercomDeviceId, connId, ws) {
  const call = activeCalls.get(intercomDeviceId);
  if (!call) return false;
  if (call.acceptedBy) return false; // already accepted by someone else
  call.acceptedBy = connId;
  call.acceptedWs = ws;
  return true;
}

function declineCall(intercomDeviceId, connId) {
  const call = activeCalls.get(intercomDeviceId);
  if (!call) return;
  call.declinedBy.add(connId);
}

function clearCall(intercomDeviceId) {
  activeCalls.delete(intercomDeviceId);
}

// ---- Per-apartment pending ring (survives WS reconnection) ----
const pendingRings = new Map(); // apartmentId → { timeout, intercomDeviceId }

function setPendingRing(apartmentId, intercomDeviceId, timeoutMs = 30000, onExpired) {
  clearPendingRing(apartmentId);
  const timeout = setTimeout(() => {
    console.log(`[PENDING] Ring expired for apartment ${apartmentId} after ${timeoutMs / 1000}s`);
    pendingRings.delete(apartmentId);
    // If no one accepted, clear the active call for this intercom
    const call = getActiveCall(intercomDeviceId);
    if (call && call.apartmentId === apartmentId && !call.acceptedBy) {
      if (onExpired) onExpired(call);
      clearCall(intercomDeviceId);
    }
  }, timeoutMs);
  pendingRings.set(apartmentId, { timeout, intercomDeviceId });
}

function clearPendingRing(apartmentId) {
  const entry = pendingRings.get(apartmentId);
  if (entry) {
    clearTimeout(entry.timeout);
    pendingRings.delete(apartmentId);
  }
}

function isPendingRing(apartmentId) {
  return pendingRings.has(apartmentId);
}

function getPendingRing(apartmentId) {
  return pendingRings.get(apartmentId) || null;
}

// ---- Legacy in-memory token maps (kept for backward compat during transition) ----
const fcmTokens = new Map();
const voipTokens = new Map();

module.exports = {
  clients,
  intercoms,
  addIntercom,
  removeIntercom,
  getIntercom,
  getIntercomForBuilding,
  homeClients,
  addHomeClient,
  removeHomeClient,
  getHomeClients,
  sendToApartment,
  activeCall: {
    start: startCall,
    get: getActiveCall,
    getByApartment: getActiveCallByApartment,
    accept: acceptCall,
    decline: declineCall,
    clear: clearCall,
  },
  activeCalls,
  setPendingRing,
  clearPendingRing,
  isPendingRing,
  getPendingRing,
  fcmTokens,
  voipTokens,
};
