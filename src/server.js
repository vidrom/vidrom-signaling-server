const { WebSocketServer } = require('ws');
const admin = require('firebase-admin');
const http = require('http');
const os = require('os');
const serviceAccount = require('../service-account.json');
const { handleRequest } = require('./httpRoutes');
const { handleConnection } = require('./wsHandler');
const { testConnection, query } = require('./db');
const { initAPNs } = require('./apnsService');
const { recoverActiveCallsFromDB } = require('./connectionState');

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const PORT = 8080;

// Log server IP
const interfaces = os.networkInterfaces();
const localIP = Object.values(interfaces)
  .flat()
  .find((i) => i.family === 'IPv4' && !i.internal)?.address || 'unknown';

// Create HTTP server and attach route handler
const httpServer = http.createServer((req, res) => handleRequest(req, res));

// Create WebSocket server on the same HTTP server
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', handleConnection);

// ---- Ping/Pong heartbeat: detect zombie connections within ~20-40s ----
const HEARTBEAT_INTERVAL_MS = 20_000;
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      console.log('[HEARTBEAT] Terminating dead socket');
      ws.terminate(); // triggers 'close' handler in wsHandler.js
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatInterval));

httpServer.listen(PORT, async () => {
  console.log(`Vidrom signaling server running on ws://${localIP}:${PORT}`);
  await testConnection();
  initAPNs();
  await recoverActiveCallsFromDB(query);
});
