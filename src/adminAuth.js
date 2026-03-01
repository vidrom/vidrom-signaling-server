// Admin authentication — whitelist and Google ID token verification
const { OAuth2Client } = require('google-auth-library');

const ADMIN_EMAILS = ['wwguyww@gmail.com', 'ronenwes@gmail.com'];
const GOOGLE_CLIENT_ID = '1070504632843-t3ohfvsimcqsjspt31v8ajpvdffait6c.apps.googleusercontent.com';
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// Verify Google ID token (from Google Identity Services) and check admin whitelist
async function verifyAdminToken(req) {
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
    const payload = ticket.getPayload();
    if (!ADMIN_EMAILS.includes(payload.email)) {
      return null;
    }
    return payload;
  } catch (err) {
    console.error('[AUTH] Admin token verification failed:', err.message);
    return null;
  }
}

module.exports = { verifyAdminToken, ADMIN_EMAILS };
