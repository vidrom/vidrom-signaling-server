const jwt = require('jsonwebtoken');

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

module.exports = { generateDeviceToken, verifyToken };
