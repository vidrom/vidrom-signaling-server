const RATE_LIMIT_BUCKETS = new Map();

const DEFAULT_CONFIG = {
  auth: {
    max: 240,
    windowMs: 5 * 60 * 1000,
  },
  mutation: {
    max: 90,
    windowMs: 60 * 1000,
  },
  provisioning: {
    max: 10,
    windowMs: 10 * 60 * 1000,
  },
};

function parsePositiveInt(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getConfig() {
  return {
    auth: {
      max: parsePositiveInt(process.env.PORTAL_RATE_LIMIT_AUTH_MAX, DEFAULT_CONFIG.auth.max),
      windowMs: parsePositiveInt(process.env.PORTAL_RATE_LIMIT_AUTH_WINDOW_MS, DEFAULT_CONFIG.auth.windowMs),
    },
    mutation: {
      max: parsePositiveInt(process.env.PORTAL_RATE_LIMIT_MUTATION_MAX, DEFAULT_CONFIG.mutation.max),
      windowMs: parsePositiveInt(process.env.PORTAL_RATE_LIMIT_MUTATION_WINDOW_MS, DEFAULT_CONFIG.mutation.windowMs),
    },
    provisioning: {
      max: parsePositiveInt(process.env.PORTAL_RATE_LIMIT_PROVISIONING_MAX, DEFAULT_CONFIG.provisioning.max),
      windowMs: parsePositiveInt(process.env.PORTAL_RATE_LIMIT_PROVISIONING_WINDOW_MS, DEFAULT_CONFIG.provisioning.windowMs),
    },
  };
}

function takeLimit(bucketName, key) {
  const config = getConfig()[bucketName];
  const now = Date.now();
  const bucketKey = `${bucketName}:${key}`;
  const existing = RATE_LIMIT_BUCKETS.get(bucketKey);

  let bucket = existing;
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + config.windowMs };
  }

  bucket.count += 1;
  RATE_LIMIT_BUCKETS.set(bucketKey, bucket);

  const limited = bucket.count > config.max;
  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  const remaining = limited ? 0 : Math.max(0, config.max - bucket.count);

  return {
    bucketName,
    limited,
    limit: config.max,
    remaining,
    retryAfterSeconds,
  };
}

function getPortalScope(path) {
  if (path.startsWith('/api/admin/')) {
    return 'admin';
  }
  if (path.startsWith('/api/management/')) {
    return 'management';
  }
  return null;
}

function getClientIp(event) {
  const headers = event.headers || {};
  const forwardedFor = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return event.requestContext?.http?.sourceIp || 'unknown';
}

function isProvisioningRoute(method, path) {
  if (method !== 'POST') {
    return false;
  }

  return /^\/api\/(?:admin|management)\/devices(?:\/[^/]+\/(?:revoke|reprovision))?$/.test(path);
}

function isMutationRoute(method, path) {
  return ['POST', 'PUT', 'DELETE'].includes(method) && getPortalScope(path) !== null;
}

function checkPortalAuthRateLimit(path, clientIp) {
  const scope = getPortalScope(path);
  if (!scope) {
    return null;
  }

  return takeLimit('auth', `${scope}:${clientIp}`);
}

function checkPortalSensitiveRateLimit(method, path, principalKey, clientIp) {
  const scope = getPortalScope(path);
  if (!scope || !principalKey) {
    return null;
  }

  if (isProvisioningRoute(method, path)) {
    return takeLimit('provisioning', `${scope}:${principalKey}:${clientIp}`);
  }

  if (isMutationRoute(method, path)) {
    return takeLimit('mutation', `${scope}:${principalKey}:${clientIp}`);
  }

  return null;
}

function getRateLimitHeaders(limitResult) {
  return {
    'Retry-After': String(limitResult.retryAfterSeconds),
    'X-RateLimit-Limit': String(limitResult.limit),
    'X-RateLimit-Remaining': String(limitResult.remaining),
  };
}

function getRateLimitError(limitResult) {
  if (limitResult.bucketName === 'provisioning') {
    return 'Too many provisioning actions';
  }
  if (limitResult.bucketName === 'mutation') {
    return 'Too many write requests';
  }
  return 'Too many requests';
}

function resetRateLimitState() {
  RATE_LIMIT_BUCKETS.clear();
}

module.exports = {
  checkPortalAuthRateLimit,
  checkPortalSensitiveRateLimit,
  getClientIp,
  getPortalScope,
  getRateLimitError,
  getRateLimitHeaders,
  resetRateLimitState,
};