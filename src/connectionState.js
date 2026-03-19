// Shared mutable state for connected clients, push tokens, and active calls
//
// Supports multiple home clients per apartment (up to 10 residents).
// When an intercom rings an apartment, ALL residents are notified.
// The first resident to accept gets the call (first-accept-wins).

// ---- Intercom client (one per server instance) ----
// clients.home is kept for legacy backward compatibility (single home client without apartmentId)
const clients = {
  intercom: null,
  home: null,
};

// ---- Home clients: apartmentId → Map<connectionId, WebSocket> ----
const homeClients = new Map();

function addHomeClient(apartmentId, connId, ws) {
  if (!homeClients.has(apartmentId)) {
    homeClients.set(apartmentId, new Map());
  }
  homeClients.get(apartmentId).set(connId, ws);
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
  for (const [, ws] of apt) {
    if (ws.readyState === 1) {
      ws.send(msg);
      sent++;
    }
  }
  return sent;
}

// ---- Active call state (one active call at a time per server) ----
let activeCall = null;
// Shape: { apartmentId, acceptedBy: connId, acceptedWs: WebSocket, declinedBy: Set<connId> }

function startCall(apartmentId) {
  activeCall = {
    apartmentId,
    acceptedBy: null,
    acceptedWs: null,
    declinedBy: new Set(),
  };
}

function getActiveCall() {
  return activeCall;
}

function acceptCall(connId, ws) {
  if (!activeCall) return false;
  if (activeCall.acceptedBy) return false; // already accepted by someone else
  activeCall.acceptedBy = connId;
  activeCall.acceptedWs = ws;
  return true;
}

function declineCall(connId) {
  if (!activeCall) return;
  activeCall.declinedBy.add(connId);
}

function clearCall() {
  activeCall = null;
}

// ---- Per-apartment pending ring (survives WS reconnection) ----
const pendingRings = new Map(); // apartmentId → timeout

function setPendingRing(apartmentId) {
  clearPendingRing(apartmentId);
  const timeout = setTimeout(() => {
    console.log(`[PENDING] Ring expired for apartment ${apartmentId} after 30s`);
    pendingRings.delete(apartmentId);
    // If no one accepted, clear the active call
    if (activeCall && activeCall.apartmentId === apartmentId && !activeCall.acceptedBy) {
      clearCall();
    }
  }, 30000);
  pendingRings.set(apartmentId, timeout);
}

function clearPendingRing(apartmentId) {
  const timeout = pendingRings.get(apartmentId);
  if (timeout) {
    clearTimeout(timeout);
    pendingRings.delete(apartmentId);
  }
}

function isPendingRing(apartmentId) {
  return pendingRings.has(apartmentId);
}

// ---- Legacy in-memory token maps (kept for backward compat during transition) ----
const fcmTokens = new Map();
const voipTokens = new Map();

module.exports = {
  clients,
  homeClients,
  addHomeClient,
  removeHomeClient,
  getHomeClients,
  sendToApartment,
  activeCall: { start: startCall, get: getActiveCall, accept: acceptCall, decline: declineCall, clear: clearCall },
  setPendingRing,
  clearPendingRing,
  isPendingRing,
  fcmTokens,
  voipTokens,
};
