// APNs VoIP Push Notification Service
// Sends PushKit VoIP notifications to iOS devices for incoming calls.
// This is Apple's recommended approach — VoIP pushes are delivered immediately
// with highest priority, even when the app is killed or device is in DND.

const apn = require('@parse/node-apn');
const path = require('path');
const fs = require('fs');

// Configuration via environment variables (with local dev defaults)
const APN_KEY_PATH = process.env.APN_KEY_PATH || path.join(__dirname, '..', 'apns-key.p8');
const APN_KEY_ID = process.env.APN_KEY_ID || '';
const APN_TEAM_ID = process.env.APN_TEAM_ID || '';
const APN_BUNDLE_ID = process.env.APN_BUNDLE_ID || 'com.vidrom.ai.home';
const APN_PRODUCTION = process.env.APN_PRODUCTION === 'true';

let provider = null;

function initAPNs() {
  if (!APN_KEY_ID || !APN_TEAM_ID) {
    console.warn('[APNs] APN_KEY_ID or APN_TEAM_ID not set — VoIP push disabled');
    console.warn('[APNs] Set APN_KEY_ID, APN_TEAM_ID env vars and place apns-key.p8 in the server root');
    return false;
  }

  if (!fs.existsSync(APN_KEY_PATH)) {
    console.warn(`[APNs] Key file not found at ${APN_KEY_PATH} — VoIP push disabled`);
    return false;
  }

  try {
    provider = new apn.Provider({
      token: {
        key: APN_KEY_PATH,
        keyId: APN_KEY_ID,
        teamId: APN_TEAM_ID,
      },
      production: APN_PRODUCTION,
    });
    console.log(`[APNs] VoIP push initialized (${APN_PRODUCTION ? 'production' : 'sandbox'}, keyId=${APN_KEY_ID})`);
    return true;
  } catch (err) {
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
async function sendVoipPush(voipToken, callerName, payloadOverride) {
  if (!provider) {
    console.warn('[APNs] Provider not initialized — skipping VoIP push');
    return { success: false, reason: 'APNs provider not initialized' };
  }

  const notification = new apn.Notification();
  notification.topic = `${APN_BUNDLE_ID}.voip`;  // PushKit requires ".voip" suffix
  notification.expiry = Math.floor(Date.now() / 1000) + 30; // 30 second TTL (call timeout)
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
