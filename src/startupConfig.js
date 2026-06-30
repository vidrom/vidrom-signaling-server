const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const LOCAL_FIREBASE_PATH = path.join(__dirname, '..', 'service-account.json');
const LOCAL_APN_KEY_PATH = path.join(__dirname, '..', 'apns-key.p8');
const DEFAULT_FALLBACK_STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
];
const DEFAULT_TWILIO_NTS_TTL_SECONDS = 86400;

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

function normalizeIceServer(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const urls = entry.urls || entry.url;
  if (!urls) return null;

  const normalized = { urls };
  if (entry.username) normalized.username = entry.username;
  if (entry.credential) normalized.credential = entry.credential;
  return normalized;
}

async function fetchTwilioIceServers(config) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable in this Node runtime.');
  }

  const { accountSid, authToken } = config.rtc.twilio;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Tokens.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: new URLSearchParams({
        Ttl: String(config.rtc.ttlSeconds),
      }),
    }
  );

  if (!response.ok) {
    const details = (await response.text()).trim();
    throw new Error(
      details
        ? `Twilio token request failed with ${response.status}: ${details}`
        : `Twilio token request failed with ${response.status}`
    );
  }

  const payload = await response.json();
  const iceServers = (payload.ice_servers || payload.iceServers || [])
    .map(normalizeIceServer)
    .filter(Boolean);

  if (iceServers.length === 0) {
    throw new Error('Twilio token response did not include any ICE servers.');
  }

  return {
    iceServers,
    ttlSeconds: config.rtc.ttlSeconds,
    expiresAt: Math.floor(Date.now() / 1000) + config.rtc.ttlSeconds,
  };
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
      ttlSeconds: parsePositiveInt(
        env.TWILIO_NTS_TTL_SECONDS || String(DEFAULT_TWILIO_NTS_TTL_SECONDS),
        DEFAULT_TWILIO_NTS_TTL_SECONDS
      ),
      fallbackStunServers: parseCsv(env.STUN_SERVERS, DEFAULT_FALLBACK_STUN_SERVERS),
      twilio: {
        accountSid: env.TWILIO_ACCOUNT_SID || '',
        authToken: env.TWILIO_AUTH_TOKEN || '',
      },
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

async function buildRtcConfig(env = process.env, _clientType = 'mobile') {
  const config = buildStartupConfig(env);

  if (!config.rtc.twilio.accountSid || !config.rtc.twilio.authToken) {
    return {
      iceServers: config.rtc.fallbackStunServers.map((urls) => ({ urls })),
    };
  }

  return fetchTwilioIceServers(config);
}

module.exports = {
  buildStartupConfig,
  validateStartupConfig,
  initializeFirebaseAdmin,
  buildRtcConfig,
  isProductionEnv,
};