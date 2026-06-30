const test = require('node:test');
const assert = require('node:assert/strict');

const { requireWithMocks } = require('../wsTestHarness');
const { canRunPostgresIntegration, startPostgresHarness } = require('./postgresHarness');
const { IDS, seedResidentFixture, seedOperatorFixture } = require('./postgresFixtures');

let dockerAvailable;
let harness;

test.before(async () => {
  dockerAvailable = await canRunPostgresIntegration();
  if (!dockerAvailable) return;
  harness = await startPostgresHarness();
});

test.after(async () => {
  if (harness) {
    await harness.close();
  }
});

test('PostgreSQL-backed resident auth resolves real apartment scope from the schema', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentFixture(harness, { firebaseUid: 'firebase-user-1' });

  const authModule = requireWithMocks('../../src/auth', {
    'firebase-admin': {
      auth() {
        return {
          async verifyIdToken(token) {
            assert.equal(token, 'resident-token');
            return {
              uid: 'firebase-user-1',
              email: 'resident@example.com',
              email_verified: true,
            };
          },
        };
      },
    },
    './db': {
      query: harness.query.bind(harness),
    },
  });

  const resident = await authModule.authenticateResidentRequest({
    headers: { authorization: 'Bearer resident-token' },
  });

  assert.equal(resident.userId, IDS.residentUser);
  assert.equal(resident.primaryApartmentId, IDS.apartment1);
  assert.deepEqual(resident.apartmentIds, [IDS.apartment1, IDS.apartment2]);
  assert.deepEqual(resident.buildingIds, [IDS.building1]);
});

test('PostgreSQL-backed resident auth backfills firebase_uid on verified email fallback', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedResidentFixture(harness, { firebaseUid: null });

  const authModule = requireWithMocks('../../src/auth', {
    'firebase-admin': {
      auth() {
        return {
          async verifyIdToken() {
            return {
              uid: 'firebase-user-2',
              email: 'resident@example.com',
              email_verified: true,
            };
          },
        };
      },
    },
    './db': {
      query: harness.query.bind(harness),
    },
  });

  const resident = await authModule.authenticateResidentRequest({
    headers: { authorization: 'Bearer resident-token' },
  });

  assert.equal(resident.firebaseUid, 'firebase-user-2');

  const updated = await harness.query('SELECT firebase_uid FROM users WHERE id = $1', [IDS.residentUser]);
  assert.equal(updated.rows[0].firebase_uid, 'firebase-user-2');
});

test('PostgreSQL-backed admin auth backfills google_subject on verified email fallback', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedOperatorFixture(harness, { role: 'admin', googleSubject: null, email: 'admin@example.com' });

  const adminAuthModule = requireWithMocks('../../lambda/adminAuth', {
    'google-auth-library': {
      OAuth2Client: class MockOAuth2Client {
        async verifyIdToken() {
          return {
            getPayload() {
              return {
                sub: 'google-subject-admin-1',
                email: 'admin@example.com',
                email_verified: true,
              };
            },
          };
        }
      },
    },
    './db': {
      query: harness.query.bind(harness),
    },
  });

  const admin = await adminAuthModule.verifyAdminToken({
    headers: { authorization: 'Bearer admin-token' },
  });

  assert.equal(admin.userId, IDS.operatorUser);
  assert.equal(admin.googleSubject, 'google-subject-admin-1');

  const updated = await harness.query('SELECT google_subject FROM users WHERE id = $1', [IDS.operatorUser]);
  assert.equal(updated.rows[0].google_subject, 'google-subject-admin-1');
});

test('PostgreSQL-backed management auth loads assigned building scope from the real join table', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedOperatorFixture(harness, { role: 'manager', googleSubject: 'google-subject-manager-1', email: 'manager@example.com' });

  const adminAuthModule = requireWithMocks('../../lambda/adminAuth', {
    'google-auth-library': {
      OAuth2Client: class MockOAuth2Client {
        async verifyIdToken() {
          return {
            getPayload() {
              return {
                sub: 'google-subject-manager-1',
                email: 'manager@example.com',
                email_verified: true,
              };
            },
          };
        }
      },
    },
    './db': {
      query: harness.query.bind(harness),
    },
  });

  const manager = await adminAuthModule.verifyManagementToken({
    headers: { authorization: 'Bearer manager-token' },
  });

  assert.equal(manager.userId, IDS.operatorUser);
  assert.deepEqual(manager.buildingIds, [IDS.building1, IDS.building2]);
});