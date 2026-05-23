const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const { OAuth2Client } = require('google-auth-library');
const { query } = require('./db');

const GOOGLE_CLIENT_ID = '1070504632843-t3ohfvsimcqsjspt31v8ajpvdffait6c.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const RESIDENT_CONTEXT_SELECT = `SELECT u.id AS user_id,
        u.email,
        u.name AS user_name,
        u.firebase_uid,
        a.id AS apartment_id,
        a.number AS apartment_number,
        a.name AS apartment_name,
        a.building_id,
        ar.created_at AS resident_linked_at
 FROM users u
 JOIN apartment_residents ar ON ar.user_id = u.id
 JOIN apartments a ON a.id = ar.apartment_id
 WHERE %WHERE_CLAUSE%
   AND u.role = 'resident'
 ORDER BY ar.created_at ASC, a.created_at ASC`;

function getJwtSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required.');
  }
  return process.env.JWT_SECRET;
}

function generateDeviceToken(deviceId, buildingId) {
  return jwt.sign(
    {
      deviceId,
      buildingId,
      role: 'intercom',
    },
    getJwtSecret(),
    { expiresIn: '365d' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, getJwtSecret());
}

function createHttpError(status, error) {
  const err = new Error(error);
  err.status = status;
  err.expose = true;
  return err;
}

function getBearerTokenFromRequest(req) {
  const authHeader = req?.headers?.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7).trim() || null;
}

async function resolveResidentContextFromClaims(decodedToken, queryFn = query) {
  const firebaseUid = typeof decodedToken?.uid === 'string' ? decodedToken.uid.trim() : '';
  const email = typeof decodedToken?.email === 'string' ? decodedToken.email.trim() : '';

  if (!firebaseUid) {
    throw createHttpError(403, 'Resident access requires a Firebase UID');
  }

  let result = await queryFn(
    RESIDENT_CONTEXT_SELECT.replace('%WHERE_CLAUSE%', 'u.firebase_uid = $1'),
    [firebaseUid]
  );

  if (result.rows.length === 0) {
    if (!email || decodedToken.email_verified === false) {
      throw createHttpError(403, 'Resident access requires a verified email');
    }

    result = await queryFn(
      RESIDENT_CONTEXT_SELECT.replace('%WHERE_CLAUSE%', 'LOWER(u.email) = LOWER($1)'),
      [email]
    );

    if (result.rows.length === 0) {
      throw createHttpError(403, 'Resident access forbidden');
    }

    const claimedFirebaseUids = new Set(
      result.rows.map((row) => row.firebase_uid).filter(Boolean)
    );
    if (claimedFirebaseUids.size > 0 && !claimedFirebaseUids.has(firebaseUid)) {
      throw createHttpError(403, 'Resident access forbidden');
    }

    await queryFn(
      `UPDATE users
       SET firebase_uid = $1
       WHERE id = $2
         AND (firebase_uid IS NULL OR firebase_uid = $1)`,
      [firebaseUid, result.rows[0].user_id]
    );
  }

  const apartmentIds = [];
  const buildingIds = [];
  const apartments = [];

  for (const row of result.rows) {
    if (!apartmentIds.includes(row.apartment_id)) {
      apartmentIds.push(row.apartment_id);
      apartments.push({
        apartmentId: row.apartment_id,
        apartmentNumber: row.apartment_number,
        apartmentName: row.apartment_name,
        buildingId: row.building_id,
      });
    }
    if (!buildingIds.includes(row.building_id)) {
      buildingIds.push(row.building_id);
    }
  }

  return {
    firebaseUid,
    email: result.rows[0].email || email,
    userId: result.rows[0].user_id,
    userName: result.rows[0].user_name,
    apartmentIds,
    primaryApartmentId: apartmentIds[0] || null,
    buildingIds,
    apartments,
    primaryApartment: apartments[0] || null,
  };
}

async function authenticateResidentRequest(req, options = {}) {
  const token = getBearerTokenFromRequest(req);
  if (!token) {
    throw createHttpError(401, 'Unauthorized');
  }

  const authClient = options.authClient || admin.auth();
  let decodedToken;
  try {
    decodedToken = await authClient.verifyIdToken(token);
  } catch {
    throw createHttpError(401, 'Unauthorized');
  }

  return resolveResidentContextFromClaims(decodedToken, options.queryFn || query);
}

async function authenticateResidentToken(token, options = {}) {
  if (!token) {
    throw createHttpError(401, 'Unauthorized');
  }

  const authClient = options.authClient || admin.auth();
  let decodedToken;
  try {
    decodedToken = await authClient.verifyIdToken(token);
  } catch {
    throw createHttpError(401, 'Unauthorized');
  }

  return resolveResidentContextFromClaims(decodedToken, options.queryFn || query);
}

function getGoogleSubject(payload) {
  return payload && typeof payload.sub === 'string' && payload.sub.trim() ? payload.sub : null;
}

async function verifyGoogleToken(token) {
  if (!token) return null;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    return ticket.getPayload();
  } catch {
    return null;
  }
}

async function authenticateAdminRequest(req, options = {}) {
  const token = getBearerTokenFromRequest(req);
  if (!token) {
    throw createHttpError(401, 'Unauthorized');
  }

  const payload = await (options.verifyGoogleToken || verifyGoogleToken)(token);
  const googleSubject = getGoogleSubject(payload);
  if (!payload || !googleSubject) {
    throw createHttpError(401, 'Unauthorized');
  }

  const queryFn = options.queryFn || query;
  let result = await queryFn(
    'SELECT id, email, name, role, google_subject FROM users WHERE google_subject = $1',
    [googleSubject]
  );

  let user = result.rows[0] || null;
  if (!user && payload.email && payload.email_verified === true) {
    result = await queryFn(
      "SELECT id, email, name, role, google_subject FROM users WHERE LOWER(email) = LOWER($1) AND role = 'admin'",
      [payload.email]
    );
    user = result.rows[0] || null;
    if (user && !user.google_subject) {
      const bound = await queryFn(
        `UPDATE users
         SET google_subject = $1
         WHERE id = $2 AND google_subject IS NULL
         RETURNING id, email, name, role, google_subject`,
        [googleSubject, user.id]
      );
      user = bound.rows[0] || user;
    }
  }

  if (!user || user.role !== 'admin' || (user.google_subject && user.google_subject !== googleSubject)) {
    throw createHttpError(403, 'Forbidden');
  }

  return { ...payload, userId: user.id, dbUser: user };
}

function residentHasApartmentAccess(residentContext, apartmentId) {
  return !!apartmentId && residentContext.apartmentIds.includes(apartmentId);
}

module.exports = {
  generateDeviceToken,
  verifyToken,
  createHttpError,
  getBearerTokenFromRequest,
  resolveResidentContextFromClaims,
  authenticateResidentRequest,
  authenticateResidentToken,
  authenticateAdminRequest,
  residentHasApartmentAccess,
};
