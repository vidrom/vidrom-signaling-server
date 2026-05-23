// Authentication — Google ID token verification with database role checking
const { OAuth2Client } = require('google-auth-library');
const { query } = require('./db');

const GOOGLE_CLIENT_ID = '1070504632843-t3ohfvsimcqsjspt31v8ajpvdffait6c.apps.googleusercontent.com';
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

function getGoogleSubject(payload) {
  return payload && typeof payload.sub === 'string' && payload.sub.trim() ? payload.sub : null;
}

// Extract and verify Google ID token from Authorization header
async function verifyGoogleToken(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const idToken = authHeader.slice(7);

  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    return ticket.getPayload();
  } catch (err) {
    console.error('[AUTH] Google token verification failed:', err.message);
    return null;
  }
}

async function findOperatorBySubject(googleSubject) {
  const result = await query(
    'SELECT id, email, name, role, google_subject FROM users WHERE google_subject = $1',
    [googleSubject]
  );
  return result.rows[0] || null;
}

async function findOperatorByEmail(email, role) {
  const result = await query(
    'SELECT id, email, name, role, google_subject FROM users WHERE LOWER(email) = LOWER($1) AND role = $2',
    [email, role]
  );
  return result.rows[0] || null;
}

async function bindGoogleSubject(userId, googleSubject) {
  try {
    const updateResult = await query(
      `UPDATE users
       SET google_subject = $1
       WHERE id = $2 AND google_subject IS NULL
       RETURNING id, email, name, role, google_subject`,
      [googleSubject, userId]
    );

    if (updateResult.rows[0]) {
      return updateResult.rows[0];
    }

    const currentResult = await query(
      'SELECT id, email, name, role, google_subject FROM users WHERE id = $1',
      [userId]
    );
    const currentUser = currentResult.rows[0] || null;
    if (currentUser && currentUser.google_subject === googleSubject) {
      return currentUser;
    }
    return null;
  } catch (err) {
    if (err && err.code === '23505') {
      console.error('[AUTH] Google subject binding conflict:', err.message);
      return null;
    }
    throw err;
  }
}

function toAuthenticatedOperator(payload, dbUser) {
  return {
    ...payload,
    googleSubject: dbUser.google_subject || getGoogleSubject(payload),
    userId: dbUser.id,
    dbUser,
  };
}

async function authenticateOperator(req, expectedRole) {
  const payload = await verifyGoogleToken(req);
  const googleSubject = getGoogleSubject(payload);
  if (!payload || !googleSubject) return null;

  try {
    const subjectUser = await findOperatorBySubject(googleSubject);
    if (subjectUser) {
      if (subjectUser.role !== expectedRole) {
        return null;
      }
      return toAuthenticatedOperator(payload, subjectUser);
    }

    if (!payload.email || payload.email_verified !== true) {
      return null;
    }

    const emailUser = await findOperatorByEmail(payload.email, expectedRole);
    if (!emailUser) {
      return null;
    }

    if (emailUser.google_subject && emailUser.google_subject !== googleSubject) {
      console.error('[AUTH] Refusing operator fallback due to conflicting google_subject binding');
      return null;
    }

    const boundUser = await bindGoogleSubject(emailUser.id, googleSubject);
    if (!boundUser) {
      return null;
    }

    return toAuthenticatedOperator(payload, boundUser);
  } catch (err) {
    console.error('[AUTH] Operator DB lookup failed:', err.message);
    return null;
  }
}

// Verify admin: Google token + persisted subject-first binding + admin role
async function verifyAdminToken(req) {
  return authenticateOperator(req, 'admin');
}

// Verify manager: Google token + persisted subject-first binding + assigned buildings
async function verifyManagementToken(req) {
  const operator = await authenticateOperator(req, 'manager');
  if (!operator) return null;

  try {
    const buildingsResult = await query(
      'SELECT building_id FROM building_managers WHERE user_id = $1',
      [operator.userId]
    );
    const buildingIds = buildingsResult.rows.map(r => r.building_id);

    return {
      ...operator,
      buildingIds,
    };
  } catch (err) {
    console.error('[AUTH] Manager DB lookup failed:', err.message);
    return null;
  }
}

module.exports = {
  getGoogleSubject,
  verifyAdminToken,
  verifyManagementToken,
  GOOGLE_CLIENT_ID,
};
