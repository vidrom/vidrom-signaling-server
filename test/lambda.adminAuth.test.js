const test = require('node:test');
const assert = require('node:assert/strict');

const { requireWithMocks } = require('./wsTestHarness');

function loadAdminAuth({ verifyIdTokenImpl, queryImpl }) {
  return requireWithMocks('../lambda/adminAuth', {
    'google-auth-library': {
      OAuth2Client: class MockOAuth2Client {
        async verifyIdToken({ idToken }) {
          return {
            getPayload() {
              return verifyIdTokenImpl(idToken);
            },
          };
        }
      },
    },
    './db': {
      query: queryImpl,
    },
  });
}

test('verifyAdminToken prefers stored google_subject over email lookup', async () => {
  const queryCalls = [];
  const authModule = loadAdminAuth({
    verifyIdTokenImpl() {
      return {
        sub: 'google-subject-1',
        email: 'new-admin@example.com',
        email_verified: false,
      };
    },
    async queryImpl(sql, params) {
      queryCalls.push({ sql, params });
      if (sql.includes('WHERE google_subject = $1')) {
        return {
          rows: [
            {
              id: 'admin-1',
              email: 'admin@example.com',
              name: 'Admin One',
              role: 'admin',
              google_subject: 'google-subject-1',
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const admin = await authModule.verifyAdminToken({
    headers: { authorization: 'Bearer admin-token' },
  });

  assert.equal(admin.userId, 'admin-1');
  assert.equal(admin.dbUser.email, 'admin@example.com');
  assert.equal(admin.googleSubject, 'google-subject-1');
  assert.equal(queryCalls.length, 1);
});

test('verifyAdminToken backfills google_subject from verified email fallback', async () => {
  const queryCalls = [];
  const authModule = loadAdminAuth({
    verifyIdTokenImpl() {
      return {
        sub: 'google-subject-2',
        email: 'admin2@example.com',
        email_verified: true,
      };
    },
    async queryImpl(sql, params) {
      queryCalls.push({ sql, params });
      if (sql.includes('WHERE google_subject = $1')) {
        return { rows: [] };
      }
      if (sql.includes('LOWER(email) = LOWER($1)')) {
        return {
          rows: [
            {
              id: 'admin-2',
              email: 'admin2@example.com',
              name: 'Admin Two',
              role: 'admin',
              google_subject: null,
            },
          ],
        };
      }
      if (sql.includes('SET google_subject = $1')) {
        return {
          rows: [
            {
              id: 'admin-2',
              email: 'admin2@example.com',
              name: 'Admin Two',
              role: 'admin',
              google_subject: 'google-subject-2',
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const admin = await authModule.verifyAdminToken({
    headers: { authorization: 'Bearer admin-token' },
  });

  assert.equal(admin.userId, 'admin-2');
  assert.equal(admin.googleSubject, 'google-subject-2');
  assert.ok(queryCalls.some(({ sql, params }) => sql.includes('SET google_subject = $1') && params[0] === 'google-subject-2'));
});

test('verifyAdminToken rejects conflicting google_subject bindings during email fallback', async () => {
  const authModule = loadAdminAuth({
    verifyIdTokenImpl() {
      return {
        sub: 'google-subject-3',
        email: 'admin3@example.com',
        email_verified: true,
      };
    },
    async queryImpl(sql) {
      if (sql.includes('WHERE google_subject = $1')) {
        return { rows: [] };
      }
      if (sql.includes('LOWER(email) = LOWER($1)')) {
        return {
          rows: [
            {
              id: 'admin-3',
              email: 'admin3@example.com',
              name: 'Admin Three',
              role: 'admin',
              google_subject: 'other-subject',
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const admin = await authModule.verifyAdminToken({
    headers: { authorization: 'Bearer admin-token' },
  });

  assert.equal(admin, null);
});

test('verifyAdminToken returns null without bearer auth', async () => {
  const authModule = loadAdminAuth({
    verifyIdTokenImpl() {
      throw new Error('verifyIdToken should not run');
    },
    async queryImpl() {
      throw new Error('query should not run');
    },
  });

  const admin = await authModule.verifyAdminToken({ headers: {} });
  assert.equal(admin, null);
});

test('verifyManagementToken prefers stored google_subject and loads assigned buildings', async () => {
  const queryCalls = [];
  const authModule = loadAdminAuth({
    verifyIdTokenImpl() {
      return {
        sub: 'google-subject-manager-1',
        email: 'manager@example.com',
        email_verified: false,
      };
    },
    async queryImpl(sql, params) {
      queryCalls.push({ sql, params });
      if (sql.includes('WHERE google_subject = $1')) {
        return {
          rows: [
            {
              id: 'manager-1',
              email: 'manager@example.com',
              name: 'Manager One',
              role: 'manager',
              google_subject: 'google-subject-manager-1',
            },
          ],
        };
      }
      if (sql.includes('FROM building_managers')) {
        return {
          rows: [
            { building_id: 'building-1' },
            { building_id: 'building-2' },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const manager = await authModule.verifyManagementToken({
    headers: { authorization: 'Bearer manager-token' },
  });

  assert.equal(manager.userId, 'manager-1');
  assert.deepEqual(manager.buildingIds, ['building-1', 'building-2']);
  assert.equal(queryCalls.length, 2);
});

test('verifyManagementToken rejects verified email fallback when token subject is already bound elsewhere', async () => {
  const authModule = loadAdminAuth({
    verifyIdTokenImpl() {
      return {
        sub: 'google-subject-manager-2',
        email: 'manager2@example.com',
        email_verified: true,
      };
    },
    async queryImpl(sql) {
      if (sql.includes('WHERE google_subject = $1')) {
        return { rows: [] };
      }
      if (sql.includes('LOWER(email) = LOWER($1)')) {
        return {
          rows: [
            {
              id: 'manager-2',
              email: 'manager2@example.com',
              name: 'Manager Two',
              role: 'manager',
              google_subject: 'other-manager-subject',
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const manager = await authModule.verifyManagementToken({
    headers: { authorization: 'Bearer manager-token' },
  });

  assert.equal(manager, null);
});