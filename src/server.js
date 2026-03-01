const { WebSocketServer } = require('ws');
const admin = require('firebase-admin');
const http = require('http');
const os = require('os');
const serviceAccount = require('../service-account.json');
const { handleRequest } = require('./httpRoutes');
const { handleConnection } = require('./wsHandler');

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

httpServer.listen(PORT, () => {
  console.log(`Vidrom signaling server running on ws://${localIP}:${PORT}`);
});
