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

module.exports = {
  hashDoorCode,
  normalizeDoorCode,
};
