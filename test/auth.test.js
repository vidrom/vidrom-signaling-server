const test = require('node:test');
const assert = require('node:assert/strict');

const { requireWithMocks } = require('./wsTestHarness');

test('authenticateResidentRequest verifies bearer auth and resolves resident scope', async () => {
  const verifiedTokens = [];
  const queryCalls = [];

  const authModule = requireWithMocks('../src/auth', {
    'firebase-admin': {
      auth() {
        return {
          async verifyIdToken(token) {
            verifiedTokens.push(token);
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
      async query(sql, params) {
        queryCalls.push({ sql, params });
        if (sql.includes('u.firebase_uid = $1')) {
          return {
            rows: [
              {
                user_id: 'user-1',
                email: 'resident@example.com',
                user_name: 'Resident One',
                firebase_uid: 'firebase-user-1',
                apartment_id: 'apt-1',
                apartment_number: '12A',
                apartment_name: 'Unit 12A',
                building_id: 'building-1',
              },
              {
                user_id: 'user-1',
                email: 'resident@example.com',
                user_name: 'Resident One',
                firebase_uid: 'firebase-user-1',
                apartment_id: 'apt-2',
                apartment_number: '14B',
                apartment_name: 'Unit 14B',
                building_id: 'building-1',
              },
            ],
          };
        }
        return {
          rows: [],
        };
      },
    },
  });

  const resident = await authModule.authenticateResidentRequest({
    headers: { authorization: 'Bearer resident-token' },
  });

  assert.deepEqual(verifiedTokens, ['resident-token']);
  assert.equal(queryCalls.length, 1);
  assert.equal(resident.firebaseUid, 'firebase-user-1');
  assert.equal(resident.userId, 'user-1');
  assert.equal(resident.primaryApartmentId, 'apt-1');
  assert.deepEqual(resident.apartmentIds, ['apt-1', 'apt-2']);
  assert.deepEqual(resident.buildingIds, ['building-1']);
});

test('authenticateResidentRequest backfills firebase_uid from verified email fallback', async () => {
  const queryCalls = [];

  const authModule = requireWithMocks('../src/auth', {
    'firebase-admin': {
      auth() {
        return {
          async verifyIdToken() {
            return {
              uid: 'firebase-user-2',
              email: 'resident2@example.com',
              email_verified: true,
            };
          },
        };
      },
    },
    './db': {
      async query(sql, params) {
        queryCalls.push({ sql, params });
        if (sql.includes('u.firebase_uid = $1')) {
          return { rows: [] };
        }
        if (sql.includes('LOWER(u.email) = LOWER($1)')) {
          return {
            rows: [
              {
                user_id: 'user-2',
                email: 'resident2@example.com',
                user_name: 'Resident Two',
                firebase_uid: null,
                apartment_id: 'apt-9',
                apartment_number: '9',
                apartment_name: 'Unit 9',
                building_id: 'building-2',
              },
            ],
          };
        }
        if (sql.includes('UPDATE users')) {
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    },
  });

  const resident = await authModule.authenticateResidentRequest({
    headers: { authorization: 'Bearer resident-token' },
  });

  assert.equal(resident.firebaseUid, 'firebase-user-2');
  assert.equal(resident.userId, 'user-2');
  assert.ok(queryCalls.some(({ sql, params }) => sql.includes('UPDATE users') && params[0] === 'firebase-user-2' && params[1] === 'user-2'));
});

test('authenticateResidentRequest rejects email fallback when a different firebase_uid is already stored', async () => {
  const authModule = requireWithMocks('../src/auth', {
    'firebase-admin': {
      auth() {
        return {
          async verifyIdToken() {
            return {
              uid: 'firebase-user-3',
              email: 'resident3@example.com',
              email_verified: true,
            };
          },
        };
      },
    },
    './db': {
      async query(sql) {
        if (sql.includes('u.firebase_uid = $1')) {
          return { rows: [] };
        }
        if (sql.includes('LOWER(u.email) = LOWER($1)')) {
          return {
            rows: [
              {
                user_id: 'user-3',
                email: 'resident3@example.com',
                user_name: 'Resident Three',
                firebase_uid: 'other-firebase-user',
                apartment_id: 'apt-3',
                apartment_number: '3',
                apartment_name: 'Unit 3',
                building_id: 'building-3',
              },
            ],
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    },
  });

  await assert.rejects(
    () => authModule.authenticateResidentRequest({ headers: { authorization: 'Bearer resident-token' } }),
    (err) => err.status === 403 && err.message === 'Resident access forbidden'
  );
});

test('authenticateResidentRequest rejects requests without bearer auth', async () => {
  const authModule = require('../src/auth');

  await assert.rejects(
    () => authModule.authenticateResidentRequest({ headers: {} }),
    (err) => err.status === 401
  );
});