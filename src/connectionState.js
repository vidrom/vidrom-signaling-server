// Shared mutable state for connected clients, FCM tokens, and pending ring

// Track connected WebSocket clients by role
const clients = {
  intercom: null,
  home: null,
};

// Store FCM tokens by role
const fcmTokens = new Map();

// Pending ring state — survives between WebSocket connections
let pendingRing = false;
let pendingRingTimeout = null;

function setPendingRing() {
  pendingRing = true;
  clearPendingRingTimeout();
  // Auto-clear after 30 seconds (ring timeout)
  pendingRingTimeout = setTimeout(() => {
    console.log('[PENDING] Ring expired after 30s');
    pendingRing = false;
  }, 30000);
}

function clearPendingRing() {
  pendingRing = false;
  clearPendingRingTimeout();
}

function clearPendingRingTimeout() {
  if (pendingRingTimeout) {
    clearTimeout(pendingRingTimeout);
    pendingRingTimeout = null;
  }
}

function isPendingRing() {
  return pendingRing;
}

module.exports = {
  clients,
  fcmTokens,
  setPendingRing,
  clearPendingRing,
  isPendingRing,
};
