const crypto = require('crypto');

const HASH_PREFIX = 'pbkdf2_sha256';
const DEFAULT_ITERATIONS = 120_000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';

function normalizeDoorCode(code) {
  return typeof code === 'string' ? code.trim() : '';
}

function hashDoorCode(code, { iterations = DEFAULT_ITERATIONS, salt = crypto.randomBytes(16).toString('base64url') } = {}) {
  const normalized = normalizeDoorCode(code);
  if (!normalized) return null;
  const hash = crypto.pbkdf2Sync(normalized, salt, iterations, KEY_LENGTH, DIGEST).toString('base64url');
  return `${HASH_PREFIX}$${iterations}$${salt}$${hash}`;
}

function verifyDoorCode(code, storedHash) {
  const normalized = normalizeDoorCode(code);
  if (!normalized || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== HASH_PREFIX) return false;
  const iterations = Number.parseInt(parts[1], 10);
  const salt = parts[2];
  const expected = parts[3];
  if (!Number.isFinite(iterations) || iterations <= 0 || !salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(normalized, salt, iterations, KEY_LENGTH, DIGEST).toString('base64url');
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

module.exports = {
  hashDoorCode,
  normalizeDoorCode,
  verifyDoorCode,
};
