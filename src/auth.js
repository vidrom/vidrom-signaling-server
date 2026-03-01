const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'vidrom-dev-secret-change-in-production';

function generateDeviceToken(deviceId, buildingId) {
  return jwt.sign(
    {
      deviceId,
      buildingId,
      role: 'intercom',
    },
    JWT_SECRET,
    { expiresIn: '365d' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { generateDeviceToken, verifyToken, JWT_SECRET };
