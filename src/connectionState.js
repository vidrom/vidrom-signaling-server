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

// HTTP-based accept: mark the call as accepted with a userId (before WS connects)
function httpAcceptCall(intercomDeviceId, userId) {
  const call = activeCalls.get(intercomDeviceId);
  if (!call) return false;
  if (call.acceptedBy) return false;
  call.acceptedBy = `http:${userId}`;
  call.httpAcceptedBy = userId;
  return true;
}

// ---- Accept reservation timer (HTTP accept must be followed by WS offer) ----
const acceptTimers = new Map(); // callId → timeout

function startAcceptTimer(callId, timeoutMs, onExpired) {
  clearAcceptTimer(callId);
  const timer = setTimeout(() => {
    acceptTimers.delete(callId);
    if (onExpired) onExpired();
  }, timeoutMs);
  acceptTimers.set(callId, timer);
}

function clearAcceptTimer(callId) {
  const timer = acceptTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    acceptTimers.delete(callId);
  }
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

// ---- Startup recovery: restore ringing state from DB after restart ----
async function recoverActiveCallsFromDB(queryFn) {
  try {
    // Mark expired calls as unanswered
    const expired = await queryFn(
      "UPDATE calls SET status = 'unanswered', updated_at = NOW() WHERE status = 'calling' AND expires_at <= NOW() RETURNING id"
    );
    if (expired.rows.length > 0) {
      console.log(`[RECOVERY] Marked ${expired.rows.length} expired call(s) as unanswered`);
      // Also time-out their delivery attempts
      const expiredIds = expired.rows.map(r => r.id);
      for (const cid of expiredIds) {
        queryFn(
          "UPDATE call_delivery_attempts SET delivery_state = 'timed-out' WHERE call_id = $1 AND delivery_state NOT IN ('accepted', 'declined', 'push-failed')",
          [cid]
        ).catch(e => console.error('[RECOVERY] Error timing-out delivery attempts:', e.message));
      }
    }

    // Recover still-active calls
    const active = await queryFn(
      "SELECT id, building_id, apartment_id, intercom_id, expires_at FROM calls WHERE status = 'calling' AND expires_at > NOW()"
    );
    if (active.rows.length === 0) {
      console.log('[RECOVERY] No active calls to recover');
      return;
    }

    for (const call of active.rows) {
      const remainingMs = new Date(call.expires_at).getTime() - Date.now();
      if (remainingMs <= 0) continue; // edge case — expired between query and now

      console.log(`[RECOVERY] Restoring call=${call.id} apartment=${call.apartment_id} intercom=${call.intercom_id} (${Math.round(remainingMs / 1000)}s remaining)`);

      // Restore activeCall in-memory state
      startCall(call.intercom_id, call.apartment_id, 'call', call.id);

      // Restore pendingRing with remaining timeout
      setPendingRing(call.apartment_id, call.intercom_id, remainingMs, (expiredCall) => {
        if (expiredCall.callId) {
          queryFn("UPDATE calls SET status = 'unanswered', updated_at = NOW() WHERE id = $1", [expiredCall.callId])
            .catch(e => console.error('[DB] recovery ring-expired update calls:', e.message));
          queryFn(
            "UPDATE call_delivery_attempts SET delivery_state = 'timed-out' WHERE call_id = $1 AND delivery_state NOT IN ('accepted', 'declined', 'push-failed')",
            [expiredCall.callId]
          ).catch(e => console.error('[DB] recovery ring-expired update attempts:', e.message));
        }
      });
    }

    console.log(`[RECOVERY] Restored ${active.rows.length} active call(s)`);
  } catch (err) {
    console.error('[RECOVERY] Failed to recover active calls:', err.message);
  }
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
    httpAccept: httpAcceptCall,
    decline: declineCall,
    clear: clearCall,
  },
  activeCalls,
  setPendingRing,
  clearPendingRing,
  isPendingRing,
  getPendingRing,
  startAcceptTimer,
  clearAcceptTimer,
  recoverActiveCallsFromDB,
  fcmTokens,
  voipTokens,
};
