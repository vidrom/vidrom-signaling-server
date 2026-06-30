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

test('validateStartupConfig allows production startup without Twilio credentials', () => {
  const config = validateStartupConfig({
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
  });

  assert.equal(config.rtc.twilio.accountSid, '');
  assert.equal(config.rtc.twilio.authToken, '');
});

test('buildRtcConfig requests Twilio ICE servers when credentials are configured', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Tokens.json');
    assert.equal(options.method, 'POST');
    assert.match(options.headers.Authorization, /^Basic /);
    assert.equal(String(options.body), 'Ttl=900');

    return {
      ok: true,
      async json() {
        return {
          ice_servers: [
            { url: 'stun:global.stun.twilio.com:3478?transport=udp' },
            {
              urls: [
                'turn:global.turn.twilio.com:3478?transport=udp',
                'turn:global.turn.twilio.com:3478?transport=tcp',
              ],
              username: 'twilio-user',
              credential: 'twilio-pass',
            },
          ],
        };
      },
    };
  };

  try {
    const before = Math.floor(Date.now() / 1000);
    const config = await buildRtcConfig({
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'twilio-auth',
      TWILIO_NTS_TTL_SECONDS: '900',
    }, 'home');

    assert.equal(config.iceServers.length, 2);
    assert.equal(config.iceServers[0].urls, 'stun:global.stun.twilio.com:3478?transport=udp');
    assert.deepEqual(config.iceServers[1], {
      urls: [
        'turn:global.turn.twilio.com:3478?transport=udp',
        'turn:global.turn.twilio.com:3478?transport=tcp',
      ],
      username: 'twilio-user',
      credential: 'twilio-pass',
    });
    assert.equal(config.ttlSeconds, 900);
    assert.ok(config.expiresAt >= before + 900);
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildRtcConfig falls back to Google STUN when Twilio credentials are missing', async () => {
  const config = await buildRtcConfig({});

  assert.deepEqual(config, {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  });
});