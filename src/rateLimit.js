const buckets = new Map();

const DEFAULT_LIMITS = {
  general: { max: 600, windowMs: 60_000 },
  provisioning: { max: 10, windowMs: 10 * 60_000 },
  rtcConfig: { max: 120, windowMs: 60_000 },
  clientError: { max: 60, windowMs: 60_000 },
  callAction: { max: 120, windowMs: 60_000 },
  debug: { max: 30, windowMs: 60_000 },
};

function parsePositiveInt(rawValue, fallback) {
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getLimitConfig(bucketName) {
  const defaults = DEFAULT_LIMITS[bucketName] || DEFAULT_LIMITS.general;
  const envPrefix = `EC2_RATE_LIMIT_${bucketName.replace(/[A-Z]/g, (match) => `_${match}`).toUpperCase()}`;
  return {
    max: parsePositiveInt(process.env[`${envPrefix}_MAX`], defaults.max),
    windowMs: parsePositiveInt(process.env[`${envPrefix}_WINDOW_MS`], defaults.windowMs),
  };
}

function getClientIp(req) {
  const forwardedFor = req.headers?.['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

function takeLimit(bucketName, key) {
  const config = getLimitConfig(bucketName);
  const now = Date.now();
  const bucketKey = `${bucketName}:${key}`;
  let bucket = buckets.get(bucketKey);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + config.windowMs };
  }

  bucket.count += 1;
  buckets.set(bucketKey, bucket);

  const limited = bucket.count > config.max;
  return {
    limited,
    limit: config.max,
    remaining: limited ? 0 : Math.max(0, config.max - bucket.count),
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

function getRouteBucket(method, urlPath) {
  if (method === 'POST' && urlPath === '/api/devices/provision') return 'provisioning';
  if (method === 'GET' && urlPath === '/api/rtc-config') return 'rtcConfig';
  if (method === 'POST' && urlPath === '/api/client-error') return 'clientError';
  if (urlPath === '/debug/status') return 'debug';
  if (urlPath === '/decline' || /^\/api\/home\/calls\/[^/]+\/(?:ack|accept)$/.test(urlPath)) return 'callAction';
  return null;
}

function checkHttpRateLimit(req, urlPath) {
  const bucketName = getRouteBucket(req.method, urlPath);
  if (!bucketName) return null;
  return takeLimit(bucketName, getClientIp(req));
}

function rateLimitHeaders(limitResult) {
  return {
    'Retry-After': String(limitResult.retryAfterSeconds),
    'X-RateLimit-Limit': String(limitResult.limit),
    'X-RateLimit-Remaining': String(limitResult.remaining),
  };
}

function resetRateLimitState() {
  buckets.clear();
}

module.exports = {
  checkHttpRateLimit,
  getClientIp,
  rateLimitHeaders,
  resetRateLimitState,
};
