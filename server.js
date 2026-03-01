const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const http = require('http');
const serviceAccount = require('./service-account.json');

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const os = require('os');

const PORT = 8080;

// Log server IP
const interfaces = os.networkInterfaces();
const localIP = Object.values(interfaces)
  .flat()
  .find((i) => i.family === 'IPv4' && !i.internal)?.address || 'unknown';

// Track connected clients by role
const clients = {
  intercom: null,
  home: null,
};

// Store FCM tokens by role
const fcmTokens = new Map();

// Create HTTP server to handle REST endpoints alongside WebSocket
const httpServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/decline') {
    // Background decline from notification action (no WebSocket available)
    console.log('[HTTP] Decline request received');
    if (clients.intercom && clients.intercom.readyState === 1) {
      clients.intercom.send(JSON.stringify({ type: 'decline' }));
      console.log('[HTTP] Decline relayed to intercom');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, () => {
  console.log(`Vidrom signaling server running on ws://${localIP}:${PORT}`);
});

wss.on('connection', (ws) => {
  const id = uuidv4();
  let role = null;

  console.log(`[${id}] New connection`);

  ws.on('message', (data) => {
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
        clients[role] = ws;
        console.log(`[${id}] Registered as "${role}"`);
        ws.send(JSON.stringify({ type: 'registered', role }));
        break;
      }

      case 'ring': {
        // Intercom rings the home app
        if (clients.home && clients.home.readyState === 1) {
          clients.home.send(JSON.stringify({ type: 'ring' }));
          console.log(`[${id}] Ring relayed to home`);
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Home app not connected' }));
          console.log(`[${id}] Ring failed: home not connected`);
        }

        // Also send FCM push notification to home app
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
            apns: {
              headers: { 'apns-priority': '10' },
              payload: {
                aps: {
                  contentAvailable: true,
                  sound: 'default',
                },
              },
            },
          })
            .then(() => console.log(`[${id}] FCM push sent to home`))
            .catch((err) => console.error(`[${id}] FCM push failed:`, err.message));
        } else {
          console.log(`[${id}] No FCM token for home, skipping push`);
        }
        break;
      }

      case 'accept': {
        // Home accepts the call
        if (clients.intercom && clients.intercom.readyState === 1) {
          clients.intercom.send(JSON.stringify({ type: 'accept' }));
          console.log(`[${id}] Accept relayed to intercom`);
        }
        break;
      }

      case 'decline': {
        // Home declines the call
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
        const other = role === 'intercom' ? clients.home : clients.intercom;
        if (other && other.readyState === 1) {
          other.send(JSON.stringify({ type: 'hangup' }));
          console.log(`[${id}] Hangup relayed`);
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
});
