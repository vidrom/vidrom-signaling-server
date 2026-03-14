// WebSocket connection handler — message routing and signaling logic
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const { verifyToken } = require('./auth');
const { getDevice } = require('./devices');
const { clients, fcmTokens, voipTokens, setPendingRing, clearPendingRing, isPendingRing } = require('./connectionState');
const { query } = require('./db');
const { sendVoipPush, isAPNsReady } = require('./apnsService');

function handleConnection(ws) {
  const id = uuidv4();
  let role = null;
  let deviceId = null;

  console.log(`[${id}] New connection`);

  ws.on('message', async (data) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch (err) {
      console.error(`[${id}] Invalid JSON:`, data.toString());
      return;
    }

    const { type } = message;
    console.log(`[${id}] Received: ${type}`);

    switch (type) {
      case 'register': {
        role = message.role; // "intercom" or "home"
        if (role !== 'intercom' && role !== 'home') {
          console.error(`[${id}] Invalid role: ${role}`);
          return;
        }

        // Intercom devices must authenticate with a JWT backed by persistent DB
        if (role === 'intercom') {
          if (!message.token) {
            console.error(`[${id}] Intercom rejected: no token provided`);
            ws.send(JSON.stringify({ type: 'error', message: 'Token required' }));
            ws.close();
            return;
          }
          try {
            const decoded = verifyToken(message.token);
            const device = await getDevice(decoded.deviceId);
            if (!device || device.status !== 'active') {
              console.error(`[${id}] Intercom rejected: device ${decoded.deviceId} not active`);
              ws.send(JSON.stringify({ type: 'error', message: 'Device revoked or not found' }));
              ws.close();
              return;
            }
            deviceId = decoded.deviceId;
            console.log(`[${id}] Intercom authenticated: device=${decoded.deviceId}, building=${decoded.buildingId}`);
            await query("UPDATE intercoms SET status = 'connected' WHERE id = $1", [deviceId]);
          } catch (err) {
            console.error(`[${id}] Intercom rejected: invalid token — ${err.message}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
            ws.close();
            return;
          }
        }

        clients[role] = ws;
        console.log(`[${id}] Registered as "${role}"`);
        ws.send(JSON.stringify({ type: 'registered', role }));

        // If home just connected and there's a pending ring, re-send it
        if (role === 'home' && isPendingRing()) {
          console.log(`[${id}] Re-sending pending ring to home`);
          ws.send(JSON.stringify({ type: 'ring' }));
        }
        break;
      }

      case 'ring': {
        // Intercom rings the home app
        setPendingRing();

        if (clients.home && clients.home.readyState === 1) {
          clients.home.send(JSON.stringify({ type: 'ring' }));
          console.log(`[${id}] Ring relayed to home`);
        } else {
          console.log(`[${id}] Home not connected via WS, pending ring set`);
        }

        // Send VoIP push to iOS (Apple's recommended approach for incoming calls)
        const homeVoipToken = voipTokens.get('home');
        if (homeVoipToken && isAPNsReady()) {
          sendVoipPush(homeVoipToken, 'Intercom')
            .then((result) => {
              if (result.success) {
                console.log(`[${id}] VoIP push sent to home (iOS)`);
              } else {
                console.error(`[${id}] VoIP push failed: ${result.reason}`);
              }
            })
            .catch((err) => console.error(`[${id}] VoIP push error:`, err.message));
        } else if (homeVoipToken) {
          console.log(`[${id}] VoIP token exists but APNs not configured — skipping VoIP push`);
        }

        // Send FCM push to Android
        const homeToken = fcmTokens.get('home');
        if (homeToken) {
          admin.messaging().send({
            token: homeToken,
            data: {
              type: 'incoming-call',
              callerName: 'Intercom',
            },
            android: {
              priority: 'high',
            },
          })
            .then(() => console.log(`[${id}] FCM push sent to home (Android)`))
            .catch((err) => console.error(`[${id}] FCM push failed:`, err.message));
        } else {
          console.log(`[${id}] No FCM token for home, skipping push`);
        }
        break;
      }

      case 'accept': {
        // Home accepts the call
        clearPendingRing();
        if (clients.intercom && clients.intercom.readyState === 1) {
          clients.intercom.send(JSON.stringify({ type: 'accept' }));
          console.log(`[${id}] Accept relayed to intercom`);
        }
        break;
      }

      case 'decline': {
        // Home declines the call
        clearPendingRing();
        if (clients.intercom && clients.intercom.readyState === 1) {
          clients.intercom.send(JSON.stringify({ type: 'decline' }));
          console.log(`[${id}] Decline relayed to intercom`);
        }
        break;
      }

      case 'offer': {
        // WebRTC SDP offer (intercom → home)
        const target = role === 'intercom' ? clients.home : clients.intercom;
        if (target && target.readyState === 1) {
          target.send(JSON.stringify({ type: 'offer', sdp: message.sdp }));
          console.log(`[${id}] Offer relayed`);
        }
        break;
      }

      case 'answer': {
        // WebRTC SDP answer (home → intercom)
        const target2 = role === 'home' ? clients.intercom : clients.home;
        if (target2 && target2.readyState === 1) {
          target2.send(JSON.stringify({ type: 'answer', sdp: message.sdp }));
          console.log(`[${id}] Answer relayed`);
        }
        break;
      }

      case 'candidate': {
        // ICE candidate exchange (bidirectional)
        const peer = role === 'intercom' ? clients.home : clients.intercom;
        if (peer && peer.readyState === 1) {
          peer.send(JSON.stringify({ type: 'candidate', candidate: message.candidate }));
          console.log(`[${id}] ICE candidate relayed`);
        }
        break;
      }

      case 'hangup': {
        // Either side hangs up
        clearPendingRing();
        const other = role === 'intercom' ? clients.home : clients.intercom;
        if (other && other.readyState === 1) {
          other.send(JSON.stringify({ type: 'hangup' }));
          console.log(`[${id}] Hangup relayed`);
        }
        break;
      }

      case 'watch': {
        // Home wants to view intercom camera
        if (clients.intercom && clients.intercom.readyState === 1) {
          clients.intercom.send(JSON.stringify({ type: 'watch' }));
          console.log(`[${id}] Watch request relayed to intercom`);
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Intercom not connected' }));
        }
        break;
      }

      case 'watch-end': {
        // Home stops watching
        const target3 = role === 'home' ? clients.intercom : clients.home;
        if (target3 && target3.readyState === 1) {
          target3.send(JSON.stringify({ type: 'watch-end' }));
          console.log(`[${id}] Watch-end relayed`);
        }
        break;
      }

      case 'register-fcm-token': {
        if (role) {
          fcmTokens.set(role, message.token);
          console.log(`[${id}] FCM token registered for "${role}"`);
        } else {
          console.log(`[${id}] FCM token received but no role registered yet`);
        }
        break;
      }

      default:
        console.log(`[${id}] Unknown message type: ${type}`);
    }
  });

  ws.on('close', () => {
    console.log(`[${id}] Disconnected (role: ${role})`);
    if (role && clients[role] === ws) {
      clients[role] = null;
      // If intercom disconnects, clear pending ring and update DB status
      if (role === 'intercom') {
        clearPendingRing();
        if (deviceId) {
          query("UPDATE intercoms SET status = 'disconnected' WHERE id = $1", [deviceId])
            .catch(err => console.error(`[${id}] Failed to update intercom status:`, err.message));
        }
      }
      // Notify the other side
      const other = role === 'intercom' ? clients.home : clients.intercom;
      if (other && other.readyState === 1) {
        other.send(JSON.stringify({ type: 'peer-disconnected', role }));
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[${id}] Error:`, err.message);
  });
}

module.exports = { handleConnection };
