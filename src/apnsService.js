// APNs VoIP Push Notification Service
// Sends PushKit VoIP notifications to iOS devices for incoming calls.
// This is Apple's recommended approach — VoIP pushes are delivered immediately
// with highest priority, even when the app is killed or device is in DND.

const apn = require('@parse/node-apn');
const fs = require('fs');
const { buildStartupConfig } = require('./startupConfig');

let provider = null;
let bundleId = '';

function initAPNs({ failFast = false } = {}) {
  const config = buildStartupConfig();
  const apnsConfig = config.apns;

  if (!apnsConfig.keyId || !apnsConfig.teamId) {
    const message = '[APNs] APN_KEY_ID or APN_TEAM_ID not set — VoIP push disabled';
    if (failFast) throw new Error(message);
    console.warn(message);
    return false;
  }

  if (!apnsConfig.keyPath || !fs.existsSync(apnsConfig.keyPath)) {
    const message = `[APNs] Key file not found at ${apnsConfig.keyPath || '<unset>'} — VoIP push disabled`;
    if (failFast) throw new Error(message);
    console.warn(message);
    return false;
  }

  try {
    provider = new apn.Provider({
      token: {
        key: apnsConfig.keyPath,
        keyId: apnsConfig.keyId,
        teamId: apnsConfig.teamId,
      },
      production: apnsConfig.production,
    });
    bundleId = apnsConfig.bundleId;
    console.log(`[APNs] VoIP push initialized (${apnsConfig.production ? 'production' : 'sandbox'}, keyId=${apnsConfig.keyId})`);
    return true;
  } catch (err) {
    if (failFast) throw err;
    console.error('[APNs] Failed to initialize:', err.message);
    return false;
  }
}

/**
 * Send a VoIP push notification to an iOS device.
 * This triggers PushKit on the device, which wakes the app and shows CallKit.
 *
 * @param {string} voipToken - The PushKit device token
 * @param {string} callerName - Display name for the caller
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
async function sendVoipPush(voipToken, callerName, payloadOverride, ttlSeconds = 30) {
  if (!provider) {
    console.warn('[APNs] Provider not initialized — skipping VoIP push');
    return { success: false, reason: 'APNs provider not initialized' };
  }

  const notification = new apn.Notification();
  notification.topic = `${bundleId}.voip`;
  notification.expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  notification.priority = 10;  // Immediate delivery
  notification.pushType = 'voip';
  notification.payload = payloadOverride || {
    callerName,
    type: 'incoming-call',
  };

  try {
    const result = await provider.send(notification, voipToken);

    if (result.sent && result.sent.length > 0) {
      return { success: true };
    }

    if (result.failed && result.failed.length > 0) {
      const failure = result.failed[0];
      const reason = failure.response?.reason || failure.error?.message || 'Unknown error';
      return { success: false, reason };
    }

    return { success: false, reason: 'Unknown result' };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

function isAPNsReady() {
  return provider !== null;
}

module.exports = { initAPNs, sendVoipPush, isAPNsReady };
