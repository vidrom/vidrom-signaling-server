// WebSocket connection handler — message routing and signaling logic
//
// Multi-tenant: supports multiple intercoms across buildings.
// Each intercom has its own active-call slot (keyed by deviceId).
// Home clients are resolved to their building's intercom via apartment → building lookup.
//
// - Intercom sends ring with apartmentId → all residents of that apartment are notified
// - First resident to accept gets the call; others receive 'call-taken'
// - WebRTC offer/answer/candidate flow between intercom ↔ accepted home client
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const { verifyToken } = require('./auth');
const { getDevice } = require('./devices');
const {
  clients, fcmTokens, voipTokens,
  addIntercom, removeIntercom, getIntercom, getIntercomForBuilding,
  addHomeClient, removeHomeClient, getHomeClients, sendToApartment,
  activeCall, activeCalls, setPendingRing, clearPendingRing, isPendingRing, getPendingRing,
} = require('./connectionState');
const { query } = require('./db');
const { sendVoipPush, isAPNsReady } = require('./apnsService');

function handleConnection(ws) {
  const id = uuidv4();
  let role = null;
  let deviceId = null;       // intercom deviceId (set on intercom register)
  let buildingId = null;      // resolved for both roles
  let apartmentId = null;     // set when home client registers with an apartment
  let intercomDeviceId = null; // which intercom this home client routes to

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
            buildingId = decoded.buildingId;
            console.log(`[${id}] Intercom authenticated: device=${deviceId}, building=${buildingId}`);
            addIntercom(deviceId, buildingId, ws);
            // Legacy fallback
            clients.intercom = ws;
            await query("UPDATE intercoms SET status = 'connected' WHERE id = $1", [deviceId]);
          } catch (err) {
            console.error(`[${id}] Intercom rejected: invalid token — ${err.message}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
            ws.close();
            return;
          }
        }

        // Home clients register with their apartmentId
        if (role === 'home') {
          apartmentId = message.apartmentId || null;
          if (apartmentId) {
            // Resolve apartment → building → intercom
            try {
              const bldgResult = await query(
                'SELECT building_id FROM apartments WHERE id = $1', [apartmentId]
              );
              if (bldgResult.rows[0]) {
                buildingId = bldgResult.rows[0].building_id;
                const intercom = getIntercomForBuilding(buildingId);
                if (intercom) {
                  intercomDeviceId = intercom.deviceId;
                }
              }
            } catch (err) {
              console.error(`[${id}] Failed to resolve building for apartment=${apartmentId}:`, err.message);
            }
            addHomeClient(apartmentId, id, ws, buildingId);
            console.log(`[${id}] Home registered for apartment=${apartmentId}, building=${buildingId}, intercom=${intercomDeviceId || 'none'}`);
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
        if (!deviceId) {
          console.error(`[${id}] Ring from non-intercom connection`);
          break;
        }

        console.log(`[${id}] Ring for apartment=${targetApartmentId} from intercom=${deviceId}`);

        // If a watch session is active on this intercom, end it first — calls take priority
        const prevCall = activeCall.get(deviceId);
        if (prevCall && prevCall.type === 'watch') {
          if (prevCall.acceptedWs && prevCall.acceptedWs.readyState === 1) {
            prevCall.acceptedWs.send(JSON.stringify({ type: 'watch-end' }));
            console.log(`[${id}] Ended active watch session for incoming ring`);
          }
          activeCall.clear(deviceId);
        }

        // Start tracking this call
        activeCall.start(deviceId, targetApartmentId, 'call');
        setPendingRing(targetApartmentId, deviceId);

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

        // Legacy in-memory tokens and WS client are no longer used for ring routing.
        // All notifications now go through the per-apartment device_tokens DB table above.

        break;
      }

      case 'accept': {
        // Home accepts the call — first-accept-wins
        // Resolve which intercom's call this home client is accepting
        const targetIntercom = intercomDeviceId || (apartmentId ? (activeCall.getByApartment(apartmentId) || {}).intercomDeviceId : null);
        const call = targetIntercom ? activeCall.get(targetIntercom) : null;
        if (!call) {
          ws.send(JSON.stringify({ type: 'error', message: 'No active call' }));
          break;
        }

        const accepted = activeCall.accept(targetIntercom, id, ws);
        if (accepted) {
          // Update this home client's intercom target
          intercomDeviceId = targetIntercom;
          // This resident won the race — relay accept to intercom
          clearPendingRing(call.apartmentId);
          const intercom = getIntercom(targetIntercom);
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'accept' }));
            console.log(`[${id}] Accept relayed to intercom=${targetIntercom} (first-accept-wins)`);
          }

          // Notify ALL OTHER home clients for this apartment that the call was taken
          const aptClients = getHomeClients(call.apartmentId);
          for (const [connId, entry] of aptClients) {
            if (connId !== id && entry.ws.readyState === 1) {
              entry.ws.send(JSON.stringify({ type: 'call-taken' }));
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
        const targetIntercom = intercomDeviceId || (apartmentId ? (activeCall.getByApartment(apartmentId) || {}).intercomDeviceId : null);
        const call = targetIntercom ? activeCall.get(targetIntercom) : null;
        if (!call) break;

        activeCall.decline(targetIntercom, id);
        console.log(`[${id}] Declined call (apartment=${call.apartmentId}, intercom=${targetIntercom})`);

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
          activeCall.clear(targetIntercom);
          const intercom = getIntercom(targetIntercom);
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'decline' }));
            console.log(`[${id}] All residents declined — relayed to intercom=${targetIntercom}`);
          }
        }
        break;
      }

      case 'offer': {
        // WebRTC SDP offer — route based on role
        if (role === 'home') {
          // Home → Intercom (route to the correct intercom for this building)
          const intercom = intercomDeviceId ? getIntercom(intercomDeviceId) : null;
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'offer', sdp: message.sdp }));
            console.log(`[${id}] Offer relayed to intercom=${intercomDeviceId}`);
          } else if (clients.intercom && clients.intercom.readyState === 1) {
            // Legacy fallback
            clients.intercom.send(JSON.stringify({ type: 'offer', sdp: message.sdp }));
            console.log(`[${id}] Offer relayed to intercom (legacy)`);
          }
        } else if (role === 'intercom') {
          // Intercom → accepted home client
          const call = activeCall.get(deviceId);
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
        if (role === 'home') {
          // Home → Intercom
          const intercom = intercomDeviceId ? getIntercom(intercomDeviceId) : null;
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'answer', sdp: message.sdp }));
            console.log(`[${id}] Answer relayed to intercom=${intercomDeviceId}`);
          } else if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'answer', sdp: message.sdp }));
            console.log(`[${id}] Answer relayed to intercom (legacy)`);
          }
        } else if (role === 'intercom') {
          // Intercom → accepted home client
          const call = activeCall.get(deviceId);
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
        if (role === 'intercom') {
          // Intercom → accepted home client
          const call = activeCall.get(deviceId);
          if (call && call.acceptedWs && call.acceptedWs.readyState === 1) {
            call.acceptedWs.send(JSON.stringify({ type: 'candidate', candidate: message.candidate }));
          } else if (clients.home && clients.home.readyState === 1) {
            clients.home.send(JSON.stringify({ type: 'candidate', candidate: message.candidate }));
          }
        } else {
          // Home → Intercom
          const intercom = intercomDeviceId ? getIntercom(intercomDeviceId) : null;
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'candidate', candidate: message.candidate }));
          } else if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'candidate', candidate: message.candidate }));
          }
        }
        console.log(`[${id}] ICE candidate relayed`);
        break;
      }

      case 'open-door': {
        // Home tells intercom to open the door
        const intercom = intercomDeviceId ? getIntercom(intercomDeviceId) : null;
        if (intercom && intercom.ws.readyState === 1) {
          intercom.ws.send(JSON.stringify({ type: 'open-door' }));
          console.log(`[${id}] Open-door relayed to intercom=${intercomDeviceId}`);
        } else if (clients.intercom && clients.intercom.readyState === 1) {
          clients.intercom.send(JSON.stringify({ type: 'open-door' }));
          console.log(`[${id}] Open-door relayed to intercom (legacy)`);
        }
        // Clear the active call
        const targetIntercom = intercomDeviceId || deviceId;
        if (targetIntercom) {
          const call = activeCall.get(targetIntercom);
          if (call) {
            clearPendingRing(call.apartmentId);
            activeCall.clear(targetIntercom);
          }
        }
        console.log(`[${id}] Hangup relayed (after open-door)`);
        break;
      }

      case 'hangup': {
        // Either side hangs up
        if (role === 'intercom') {
          const call = activeCall.get(deviceId);
          if (call) {
            clearPendingRing(call.apartmentId);
            // Notify the accepted home client + all ringing clients
            if (call.acceptedWs && call.acceptedWs.readyState === 1) {
              call.acceptedWs.send(JSON.stringify({ type: 'hangup' }));
            }
            sendToApartment(call.apartmentId, { type: 'hangup' });
            activeCall.clear(deviceId);
          }
          // Legacy fallback
          if (clients.home && clients.home.readyState === 1) {
            clients.home.send(JSON.stringify({ type: 'hangup' }));
          }
        } else {
          // Home hung up — notify the correct intercom
          const targetIntercom = intercomDeviceId || (apartmentId ? (activeCall.getByApartment(apartmentId) || {}).intercomDeviceId : null);
          if (targetIntercom) {
            const call = activeCall.get(targetIntercom);
            if (call) {
              clearPendingRing(call.apartmentId);
              activeCall.clear(targetIntercom);
            }
            const intercom = getIntercom(targetIntercom);
            if (intercom && intercom.ws.readyState === 1) {
              intercom.ws.send(JSON.stringify({ type: 'hangup' }));
              console.log(`[${id}] Hangup relayed to intercom=${targetIntercom}`);
            }
          } else if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'hangup' }));
            console.log(`[${id}] Hangup relayed to intercom (legacy)`);
          }
        }
        break;
      }

      case 'watch': {
        // Home wants to view intercom camera — route to their building's intercom
        const intercom = intercomDeviceId ? getIntercom(intercomDeviceId) : null;
        const targetWs = intercom ? intercom.ws : clients.intercom;
        const targetDeviceId = intercomDeviceId || deviceId;

        if (targetWs && targetWs.readyState === 1) {
          const call = targetDeviceId ? activeCall.get(targetDeviceId) : null;

          // Don't allow watch during an active call
          if (call && call.type === 'call') {
            ws.send(JSON.stringify({ type: 'error', message: 'Intercom is busy on a call' }));
            console.log(`[${id}] Watch rejected — active call in progress on intercom=${targetDeviceId}`);
            break;
          }

          // If someone else is already watching this intercom, end their session
          if (call && call.type === 'watch' && call.acceptedWs && call.acceptedWs.readyState === 1) {
            call.acceptedWs.send(JSON.stringify({ type: 'watch-end' }));
            console.log(`[${id}] Displaced previous watcher on intercom=${targetDeviceId}`);
            targetWs.send(JSON.stringify({ type: 'watch-end' }));
          }

          // Track this as a watch so offer/answer/candidate routes correctly
          if (targetDeviceId && apartmentId) {
            activeCall.start(targetDeviceId, apartmentId, 'watch');
            activeCall.accept(targetDeviceId, id, ws);
          }
          targetWs.send(JSON.stringify({ type: 'watch' }));
          console.log(`[${id}] Watch request relayed to intercom=${targetDeviceId}`);
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Intercom not connected' }));
        }
        break;
      }

      case 'watch-end': {
        const targetIntercom = role === 'intercom' ? deviceId
          : (intercomDeviceId || (apartmentId ? (activeCall.getByApartment(apartmentId) || {}).intercomDeviceId : null));
        const call = targetIntercom ? activeCall.get(targetIntercom) : null;

        // Only clear if this is a watch session (don't accidentally clear an active call)
        if (call && call.type === 'watch') activeCall.clear(targetIntercom);

        if (role === 'home') {
          const intercom = targetIntercom ? getIntercom(targetIntercom) : null;
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'watch-end' }));
            console.log(`[${id}] Watch-end relayed to intercom=${targetIntercom}`);
          } else if (clients.intercom && clients.intercom.readyState === 1) {
            clients.intercom.send(JSON.stringify({ type: 'watch-end' }));
            console.log(`[${id}] Watch-end relayed to intercom (legacy)`);
          }
        } else {
          if (call && call.acceptedWs && call.acceptedWs.readyState === 1) {
            call.acceptedWs.send(JSON.stringify({ type: 'watch-end' }));
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
      if (deviceId) {
        // Notify home clients for any active call on this intercom
        const call = activeCall.get(deviceId);
        if (call) {
          clearPendingRing(call.apartmentId);
          sendToApartment(call.apartmentId, { type: 'peer-disconnected', role: 'intercom' });
          activeCall.clear(deviceId);
        }
        removeIntercom(deviceId);
        query("UPDATE intercoms SET status = 'disconnected' WHERE id = $1", [deviceId])
          .catch(err => console.error(`[${id}] Failed to update intercom status:`, err.message));
      }
      // Legacy fallback
      if (clients.intercom === ws) clients.intercom = null;
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
      // Find if this home client was part of an active call
      const targetIntercom = intercomDeviceId || (apartmentId ? (activeCall.getByApartment(apartmentId) || {}).intercomDeviceId : null);
      const call = targetIntercom ? activeCall.get(targetIntercom) : null;

      if (call && call.acceptedBy === id) {
        // Accepted client disconnected — notify intercom
        activeCall.clear(targetIntercom);
        const intercom = getIntercom(targetIntercom);
        if (intercom && intercom.ws.readyState === 1) {
          intercom.ws.send(JSON.stringify({ type: 'peer-disconnected', role: 'home' }));
        }
      } else if (call && call.apartmentId === apartmentId && !call.acceptedBy) {
        // Ringing client disconnected — treat as implicit decline
        activeCall.decline(targetIntercom, id);
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
          activeCall.clear(targetIntercom);
          const intercom = getIntercom(targetIntercom);
          if (intercom && intercom.ws.readyState === 1) {
            intercom.ws.send(JSON.stringify({ type: 'decline' }));
            console.log(`[${id}] All residents declined/disconnected — relayed to intercom=${targetIntercom}`);
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
