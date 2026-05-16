const admin = require('firebase-admin');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOCAL_FIREBASE_PATH = path.join(__dirname, '..', 'service-account.json');
const LOCAL_APN_KEY_PATH = path.join(__dirname, '..', 'apns-key.p8');
const DEFAULT_STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:52.203.117.37:3478',
];

function isProductionEnv(env = process.env) {
  return (env.NODE_ENV || 'development') === 'production';
}

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function parseCsv(value, fallback = []) {
  if (!value) return fallback;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getLocalFallbackPath(filePath, allowFallback) {
  if (!allowFallback) return '';
  return fs.existsSync(filePath) ? filePath : '';
}

function buildStartupConfig(env = process.env) {
  const isProduction = isProductionEnv(env);
  const allowLocalFallbacks = !isProduction;

  return {
    isProduction,
    jwtSecret: env.JWT_SECRET || '',
    db: {
      host: env.DB_HOST || 'localhost',
      port: parsePositiveInt(env.DB_PORT || '5432', 5432),
      name: env.DB_NAME || 'vidrom',
      user: env.DB_USER || 'vidrom',
      password: env.DB_PASSWORD || '',
    },
    firebase: {
      serviceAccountJson: env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
      serviceAccountPath:
        env.FIREBASE_SERVICE_ACCOUNT_PATH ||
        env.GOOGLE_APPLICATION_CREDENTIALS ||
        getLocalFallbackPath(LOCAL_FIREBASE_PATH, allowLocalFallbacks),
    },
    apns: {
      keyPath: env.APN_KEY_PATH || getLocalFallbackPath(LOCAL_APN_KEY_PATH, allowLocalFallbacks),
      keyId: env.APN_KEY_ID || '',
      teamId: env.APN_TEAM_ID || '',
      bundleId: env.APN_BUNDLE_ID || (allowLocalFallbacks ? 'com.vidrom.ai.home' : ''),
      production: parseBoolean(env.APN_PRODUCTION, isProduction),
    },
    rtc: {
      host: env.TURN_HOST || env.TURN_PUBLIC_IP || '52.203.117.37',
      port: parsePositiveInt(env.TURN_PORT || '3478', 3478),
      realm: env.TURN_REALM || 'vidrom.com',
      sharedSecret: env.TURN_SHARED_SECRET || '',
      ttlSeconds: parsePositiveInt(env.TURN_TTL_SECONDS || '600', 600),
      stunServers: parseCsv(env.STUN_SERVERS, DEFAULT_STUN_SERVERS),
    },
  };
}

function validateStartupConfig(env = process.env) {
  const config = buildStartupConfig(env);
  const errors = [];

  if (!config.jwtSecret) {
    errors.push('JWT_SECRET is required.');
  }

  if (config.isProduction) {
    if (!env.DB_HOST) errors.push('DB_HOST is required in production.');
    if (!env.DB_PORT) errors.push('DB_PORT is required in production.');
    if (!env.DB_NAME) errors.push('DB_NAME is required in production.');
    if (!env.DB_USER) errors.push('DB_USER is required in production.');
    if (!env.DB_PASSWORD) errors.push('DB_PASSWORD is required in production.');

    if (!config.firebase.serviceAccountJson && !config.firebase.serviceAccountPath) {
      errors.push('Firebase admin credentials are required in production via FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_PATH, or GOOGLE_APPLICATION_CREDENTIALS.');
    }

    if (!config.apns.keyPath) errors.push('APN_KEY_PATH is required in production.');
    if (!config.apns.keyId) errors.push('APN_KEY_ID is required in production.');
    if (!config.apns.teamId) errors.push('APN_TEAM_ID is required in production.');
    if (!config.apns.bundleId) errors.push('APN_BUNDLE_ID is required in production.');

    if (!config.rtc.sharedSecret) {
      errors.push('TURN_SHARED_SECRET is required in production to issue runtime TURN credentials.');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Startup validation failed:\n- ${errors.join('\n- ')}`);
  }

  return config;
}

function loadFirebaseServiceAccount(config = buildStartupConfig()) {
  if (config.firebase.serviceAccountJson) {
    return JSON.parse(config.firebase.serviceAccountJson);
  }
  if (!config.firebase.serviceAccountPath) {
    throw new Error('Firebase admin credentials are not configured.');
  }
  return JSON.parse(fs.readFileSync(config.firebase.serviceAccountPath, 'utf8'));
}

function initializeFirebaseAdmin(env = process.env) {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  const config = buildStartupConfig(env);
  const serviceAccount = loadFirebaseServiceAccount(config);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  return admin.app();
}

function buildRtcConfig(env = process.env, clientType = 'mobile') {
  const config = buildStartupConfig(env);
  const iceServers = config.rtc.stunServers.map((urls) => ({ urls }));
  const stunHost = `stun:${config.rtc.host}:${config.rtc.port}`;

  if (!config.rtc.stunServers.includes(stunHost)) {
    iceServers.push({ urls: stunHost });
  }

  if (!config.rtc.sharedSecret) {
    return { iceServers };
  }

  const expiresAt = Math.floor(Date.now() / 1000) + config.rtc.ttlSeconds;
  const username = `${expiresAt}:${clientType}`;
  const credential = crypto
    .createHmac('sha1', config.rtc.sharedSecret)
    .update(username)
    .digest('base64');

  iceServers.push({
    urls: [
      `turn:${config.rtc.host}:${config.rtc.port}?transport=udp`,
      `turn:${config.rtc.host}:${config.rtc.port}?transport=tcp`,
    ],
    username,
    credential,
  });

  return {
    iceServers,
    ttlSeconds: config.rtc.ttlSeconds,
    expiresAt,
  };
}

module.exports = {
  buildStartupConfig,
  validateStartupConfig,
  initializeFirebaseAdmin,
  buildRtcConfig,
  isProductionEnv,
};