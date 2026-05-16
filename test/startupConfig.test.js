const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildRtcConfig,
  validateStartupConfig,
} = require('../src/startupConfig');

test('validateStartupConfig requires JWT_SECRET', () => {
  assert.throws(
    () => validateStartupConfig({ NODE_ENV: 'development' }),
    /JWT_SECRET is required\./
  );
});

test('buildRtcConfig returns short-lived TURN credentials when TURN_SHARED_SECRET is set', () => {
  const config = buildRtcConfig({
    NODE_ENV: 'production',
    JWT_SECRET: 'secret',
    DB_HOST: 'db.example.com',
    DB_PORT: '5432',
    DB_NAME: 'vidrom',
    DB_USER: 'vidrom',
    DB_PASSWORD: 'password',
    FIREBASE_SERVICE_ACCOUNT_JSON: '{"type":"service_account","project_id":"demo","private_key_id":"abc","private_key":"-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n","client_email":"demo@example.com","client_id":"1"}',
    APN_KEY_PATH: '/tmp/apns-key.p8',
    APN_KEY_ID: 'KEY123',
    APN_TEAM_ID: 'TEAM123',
    APN_BUNDLE_ID: 'com.vidrom.ai.home',
    TURN_SHARED_SECRET: 'turn-secret',
    TURN_HOST: 'turn.example.com',
    TURN_PORT: '3478',
    TURN_TTL_SECONDS: '900',
  }, 'home');

  const turnServer = config.iceServers.find((entry) => {
    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    return urls.some((url) => String(url).startsWith('turn:'));
  });

  assert.ok(turnServer);
  assert.match(turnServer.username, /^\d+:home$/);
  assert.ok(turnServer.credential);
  assert.equal(config.ttlSeconds, 900);
});