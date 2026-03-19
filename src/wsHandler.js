// WebSocket connection handler — message routing and signaling logic
//
// Supports per-apartment notification routing and first-accept-wins:
// - Intercom sends ring with apartmentId → all residents of that apartment are notified
// - First resident to accept gets the call; others receive 'call-taken'
// - WebRTC offer/answer/candidate flow between intercom ↔ accepted home client
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const { verifyToken } = require('./auth');
const { getDevice } = require('./devices');
const {
  clients, fcmTokens, voipTokens,
  addHomeClient, removeHomeClient, getHomeClients, sendToApartment,
  activeCall, setPendingRing, clearPendingRing, isPendingRing,
} = require('./connectionState');
const { query } = require('./db');
const { sendVoipPush, isAPNsReady } = require('./apnsService');

function handleConnection(ws) {
  const id = uuidv4();
  let role = null;
  let deviceId = null;
  let apartmentId = null; // set when home client registers with an apartment

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
          clients.intercom = ws;
        }

        // Home clients register with their apartmentId
        if (role === 'home') {
          apartmentId = message.apartmentId || null;
          if (apartmentId) {
            addHomeClient(apartmentId, id, ws);
            console.log(`[${id}] Home registered for apartment=${apartmentId}`);
          } else {
            // Legacy: no apartmentId — treat as single home client
            clients.home = ws;
            console.log(`[${id}] Home registered (legacy, no apartmentId)`);
          }
        }

        console.log(`[${id}] Registered as "${role}"`);
        ws.send(JSON.stringify({ type: 'registered', role }));

        // If home just connected and there's a pending ring for their apartment, re-send it
        if (role === 'home' && apartmentId && isPendingRing(apartmentId)) {
          console.log(`[${id}] Re-sending pending ring to home (apartment=${apartmentId})`);
          ws.send(JSON.stringify({ type: 'ring' }));
        }
        break;
      }

      case 'ring': {
        // Intercom rings a specific apartment
        const targetApartmentId = message.apartmentId;
        if (!targetApartmentId) {
          console.error(`[${id}] Ring without apartmentId`);
          break;
        }

        console.log(`[${id}] Ring for apartment=${targetApartmentId}`);

        // Start tracking this call
        activeCall.start(targetApartmentId);
        setPendingRing(targetApartmentId);

        // 1. Send WS ring to all connected home clients for this apartment
        const wsSent = sendToApartment(targetApartmentId, { type: 'ring' });
        console.log(`[${id}] Ring sent to ${wsSent} connected home client(s)`);

        // 2. Send push notifications to all registered devices for this apartment (from DB)
        try {
          const tokenResult = await query(
            'SELECT token, token_type, platform FROM device_tokens WHERE apartment_id = $1',
            [targetApartmentId]
          );

          for (const row of tokenResult.rows) {
            if (row.token_type === 'voip' && isAPNsReady()) {
              // iOS VoIP push
              sendVoipPush(row.token, 'Intercom')
                .then((result) => {
                  if (result.success) {
                    console.log(`[${id}] VoIP push sent (apartment=${targetApartmentId})`);
                  } else {
                    console.error(`[${id}] VoIP push failed: ${result.reason}`);
                  }
                })
                .catch((err) => console.error(`[${id}] VoIP push error:`, err.message));
            } else if (row.token_type === 'fcm') {
              // FCM push (Android or iOS fallback)
              admin.messaging().send({
                token: row.token,
                data: {
                  type: 'incoming-call',
                  callerName: 'Intercom',
                  apartmentId: targetApartmentId,
                },
                android: { priority: 'high' },
              })
                .then(() => console.log(`[${id}] FCM push sent (apartment=${targetApartmentId}, platform=${row.platform})`))
                .catch((err) => console.error(`[${id}] FCM push failed:`, err.message));
            }
          }

          if (tokenResult.rows.length === 0) {
            console.log(`[${id}] No push tokens found for apartment=${targetApartmentId}`);
          }
        } catch (err) {
          console.error(`[${id}] Error querying device tokens:`, err.message);
        }

        // 3. Fallback: also try legacy in-memory tokens (for backward compatibility)
        const legacyVoip = voipTokens.get('home');
        const legacyFcm = fcmTokens.get('home');
        if (legacyVoip && isAPNsReady()) {
          sendVoipPush(legacyVoip, 'Intercom')
            .then((r) => r.success && console.log(`[${id}] VoIP push sent (legacy)`))
            .catch(() => {});
        }
        if (legacyFcm) {
          admin.messaging().send({
            token: legacyFcm,
            data: { type: 'incoming-call', callerName: 'Intercom' },
            android: { priority: 'high' },
          })
            .then(() => console.log(`[${id}] FCM push sent (legacy)`))
            .catch(() => {});
        }
        // Also send to legacy WS client
        if (clients.home && clients.home.readyState === 1) {
          clients.home.send(JSON.stringify({ type: 'ring' }));
          console.log(`[${id}] Ring sent to legacy home client`);
        }

        break;
      }

      case 'accept': {
        // Home accepts the call — first-accept-wins
        const call = activeCall.get();
        if (!call) {
          ws.send(JSON.stringify({ type: 'error', message: 'No active call' }));
          break;
        }

        const accepted = activeCall.accept(id, ws);
        if (accepted) {
          // This resident won the race — relay accept to intercom
          clearPendingRing(call.apartmentId);
          if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'accept' }));
            console.log(`[${id}] Accept relayed to intercom (first-accept-wins)`);
          }

          // Notify ALL OTHER home clients for this apartment that the call was taken
          const aptClients = getHomeClients(call.apartmentId);
          for (const [connId, clientWs] of aptClients) {
            if (connId !== id && clientWs.readyState === 1) {
              clientWs.send(JSON.stringify({ type: 'call-taken' }));
              console.log(`[${id}] Sent call-taken to ${connId}`);
            }
          }
          // Also notify legacy home client if it's not the acceptor
          if (clients.home && clients.home !== ws && clients.home.readyState === 1) {
            clients.home.send(JSON.stringify({ type: 'call-taken' }));
          }
        } else {
          // Someone else already accepted — tell this client
          ws.send(JSON.stringify({ type: 'call-taken' }));
          console.log(`[${id}] Call already accepted, sent call-taken`);
        }
        break;
      }

      case 'decline': {
        // Individual resident declines — doesn't end the call for others
        const call = activeCall.get();
        if (!call) break;

        activeCall.decline(id);
        console.log(`[${id}] Declined call (apartment=${call.apartmentId})`);

        // Check if ALL connected home clients for this apartment have declined
        const aptClients = getHomeClients(call.apartmentId);
        let allDeclined = true;
        for (const [connId] of aptClients) {
          if (!call.declinedBy.has(connId)) {
            allDeclined = false;
            break;
          }
        }

        if (allDeclined && aptClients.size > 0) {
          // Everyone declined — relay to intercom
          clearPendingRing(call.apartmentId);
          activeCall.clear();
          if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'decline' }));
            console.log(`[${id}] All residents declined — relayed to intercom`);
          }
        }
        break;
      }

      case 'offer': {
        // WebRTC SDP offer — route based on role
        const call = activeCall.get();
        if (role === 'home') {
          // Home → Intercom
          if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'offer', sdp: message.sdp }));
            console.log(`[${id}] Offer relayed to intercom`);
          }
        } else if (role === 'intercom') {
          // Intercom → accepted home client
          if (call && call.acceptedWs && call.acceptedWs.readyState === 1) {
            call.acceptedWs.send(JSON.stringify({ type: 'offer', sdp: message.sdp }));
            console.log(`[${id}] Offer relayed to accepted home`);
          } else if (clients.home && clients.home.readyState === 1) {
            // Legacy fallback
            clients.home.send(JSON.stringify({ type: 'offer', sdp: message.sdp }));
            console.log(`[${id}] Offer relayed to home (legacy)`);
          }
        }
        break;
      }

      case 'answer': {
        // WebRTC SDP answer — route based on role
        const call = activeCall.get();
        if (role === 'home') {
          // Home → Intercom
          if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'answer', sdp: message.sdp }));
            console.log(`[${id}] Answer relayed to intercom`);
          }
        } else if (role === 'intercom') {
          // Intercom → accepted home client
          if (call && call.acceptedWs && call.acceptedWs.readyState === 1) {
            call.acceptedWs.send(JSON.stringify({ type: 'answer', sdp: message.sdp }));
            console.log(`[${id}] Answer relayed to accepted home`);
          } else if (clients.home && clients.home.readyState === 1) {
            clients.home.send(JSON.stringify({ type: 'answer', sdp: message.sdp }));
            console.log(`[${id}] Answer relayed to home (legacy)`);
          }
        }
        break;
      }

      case 'candidate': {
        // ICE candidate exchange (bidirectional)
        const call = activeCall.get();
        if (role === 'intercom') {
          // Intercom → accepted home client
          if (call && call.acceptedWs && call.acceptedWs.readyState === 1) {
            call.acceptedWs.send(JSON.stringify({ type: 'candidate', candidate: message.candidate }));
          } else if (clients.home && clients.home.readyState === 1) {
            clients.home.send(JSON.stringify({ type: 'candidate', candidate: message.candidate }));
          }
        } else {
          // Home → Intercom
          if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'candidate', candidate: message.candidate }));
          }
        }
        console.log(`[${id}] ICE candidate relayed`);
        break;
      }

      case 'open-door': {
        // Home tells intercom to open the door
        if (clients.intercom && clients.intercom.readyState === 1) {
          clients.intercom.send(JSON.stringify({ type: 'open-door' }));
          console.log(`[${id}] Open-door relayed to intercom`);
        }
        // Also relay as hangup so both sides clean up
        const call = activeCall.get();
        if (call) {
          clearPendingRing(call.apartmentId);
          activeCall.clear();
        }
        if (role === 'intercom') {
          const call2 = activeCall.get();
          if (call2 && call2.acceptedWs && call2.acceptedWs.readyState === 1) {
            call2.acceptedWs.send(JSON.stringify({ type: 'hangup' }));
          } else if (clients.home && clients.home.readyState === 1) {
            clients.home.send(JSON.stringify({ type: 'hangup' }));
          }
        } else {
          // Home sent open-door — hangup goes to intercom (already sent open-door above)
        }
        console.log(`[${id}] Hangup relayed (after open-door)`);
        break;
      }

      case 'hangup': {
        // Either side hangs up
        const call = activeCall.get();
        if (call) {
          clearPendingRing(call.apartmentId);
          activeCall.clear();
        }
        if (role === 'intercom') {
          // Intercom hung up — notify the accepted home client + all ringing clients
          if (call && call.acceptedWs && call.acceptedWs.readyState === 1) {
            call.acceptedWs.send(JSON.stringify({ type: 'hangup' }));
          }
          if (call) {
            sendToApartment(call.apartmentId, { type: 'hangup' });
          }
          // Legacy fallback
          if (clients.home && clients.home.readyState === 1) {
            clients.home.send(JSON.stringify({ type: 'hangup' }));
          }
        } else {
          // Home hung up — notify intercom
          if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'hangup' }));
            console.log(`[${id}] Hangup relayed to intercom`);
          }
        }
        break;
      }

      case 'watch': {
        // Home wants to view intercom camera
        if (clients.intercom && clients.intercom.readyState === 1) {
          // Track this as a call so offer/answer/candidate routes correctly
          if (apartmentId) {
            activeCall.start(apartmentId);
            activeCall.accept(id, ws);
          }
          clients.intercom.send(JSON.stringify({ type: 'watch' }));
          console.log(`[${id}] Watch request relayed to intercom`);
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Intercom not connected' }));
        }
        break;
      }

      case 'watch-end': {
        const call = activeCall.get();
        if (call) activeCall.clear();
        if (role === 'home') {
          if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'watch-end' }));
            console.log(`[${id}] Watch-end relayed to intercom`);
          }
        } else {
          const call2 = activeCall.get();
          if (call2 && call2.acceptedWs && call2.acceptedWs.readyState === 1) {
            call2.acceptedWs.send(JSON.stringify({ type: 'watch-end' }));
          } else if (clients.home && clients.home.readyState === 1) {
            clients.home.send(JSON.stringify({ type: 'watch-end' }));
          }
        }
        break;
      }

      case 'register-fcm-token': {
        // WS-based FCM token registration
        if (apartmentId && message.userId) {
          const platform = message.platform || 'android';
          await query(
            `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, updated_at)
             VALUES ($1, $2, $3, 'fcm', $4, NOW())
             ON CONFLICT (token, token_type) DO UPDATE SET apartment_id = $1, user_id = $2, platform = $4, updated_at = NOW()`,
            [apartmentId, message.userId, message.token, platform]
          );
          console.log(`[${id}] FCM token registered via WS (apartment=${apartmentId})`);
        } else if (role) {
          // Legacy fallback
          fcmTokens.set(role, message.token);
          console.log(`[${id}] FCM token registered for "${role}" (legacy)`);
        }
        break;
      }

      default:
        console.log(`[${id}] Unknown message type: ${type}`);
    }
  });

  ws.on('close', () => {
    console.log(`[${id}] Disconnected (role: ${role})`);

    if (role === 'intercom') {
      if (clients.intercom === ws) clients.intercom = null;
      const call = activeCall.get();
      if (call) {
        clearPendingRing(call.apartmentId);
        // Notify all connected home clients for the call's apartment
        sendToApartment(call.apartmentId, { type: 'peer-disconnected', role: 'intercom' });
        activeCall.clear();
      }
      if (deviceId) {
        query("UPDATE intercoms SET status = 'disconnected' WHERE id = $1", [deviceId])
          .catch(err => console.error(`[${id}] Failed to update intercom status:`, err.message));
      }
      // Legacy fallback
      if (clients.home && clients.home.readyState === 1) {
        clients.home.send(JSON.stringify({ type: 'peer-disconnected', role: 'intercom' }));
      }
    }

    if (role === 'home') {
      if (apartmentId) {
        removeHomeClient(apartmentId, id);
      }
      if (clients.home === ws) {
        clients.home = null;
      }
      const call = activeCall.get();
      if (call && call.acceptedBy === id) {
        // Accepted client disconnected — notify intercom
        activeCall.clear();
        if (clients.intercom && clients.intercom.readyState === 1) {
          clients.intercom.send(JSON.stringify({ type: 'peer-disconnected', role: 'home' }));
        }
      } else if (call && call.apartmentId === apartmentId && !call.acceptedBy) {
        // Ringing client disconnected — treat as implicit decline
        activeCall.decline(id);
        const aptClients = getHomeClients(call.apartmentId);
        let allDeclined = true;
        for (const [connId] of aptClients) {
          if (!call.declinedBy.has(connId)) {
            allDeclined = false;
            break;
          }
        }
        if (allDeclined) {
          clearPendingRing(call.apartmentId);
          activeCall.clear();
          if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'decline' }));
            console.log(`[${id}] All residents declined/disconnected — relayed to intercom`);
          }
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[${id}] Error:`, err.message);
  });
}

module.exports = { handleConnection };
