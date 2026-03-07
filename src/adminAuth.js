// Authentication — Google ID token verification with database role checking
const { OAuth2Client } = require('google-auth-library');
const { query } = require('./db');

const GOOGLE_CLIENT_ID = '1070504632843-t3ohfvsimcqsjspt31v8ajpvdffait6c.apps.googleusercontent.com';
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

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

// Verify admin: Google token + role = 'admin' in users table
async function verifyAdminToken(req) {
  const payload = await verifyGoogleToken(req);
  if (!payload) return null;

  try {
    const result = await query(
      'SELECT id, email, name, role FROM users WHERE email = $1 AND role = $2',
      [payload.email, 'admin']
    );
    if (result.rows.length === 0) return null;
    return { ...payload, userId: result.rows[0].id, dbUser: result.rows[0] };
  } catch (err) {
    console.error('[AUTH] Admin DB lookup failed:', err.message);
    return null;
  }
}

// Verify manager: Google token + role = 'manager' in users table + load assigned buildings
async function verifyManagementToken(req) {
  const payload = await verifyGoogleToken(req);
  if (!payload) return null;

  try {
    const userResult = await query(
      'SELECT id, email, name, role FROM users WHERE email = $1 AND role = $2',
      [payload.email, 'manager']
    );
    if (userResult.rows.length === 0) return null;

    const user = userResult.rows[0];
    const buildingsResult = await query(
      'SELECT building_id FROM building_managers WHERE user_id = $1',
      [user.id]
    );
    const buildingIds = buildingsResult.rows.map(r => r.building_id);

    return {
      ...payload,
      userId: user.id,
      dbUser: user,
      buildingIds,
    };
  } catch (err) {
    console.error('[AUTH] Manager DB lookup failed:', err.message);
    return null;
  }
}

module.exports = { verifyAdminToken, verifyManagementToken, GOOGLE_CLIENT_ID };
