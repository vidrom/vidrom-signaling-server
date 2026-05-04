const DEFAULT_RING_TIMEOUT_SEC = 30;

function normalizeRingTimeoutSec(value, fallback = DEFAULT_RING_TIMEOUT_SEC) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function resolveRingTimeoutSec(queryFn, apartmentId, defaultTimeoutSec = DEFAULT_RING_TIMEOUT_SEC) {
  const fallbackTimeoutSec = normalizeRingTimeoutSec(defaultTimeoutSec);

  try {
    const buildingResult = await queryFn(
      'SELECT b.no_answer_timeout FROM buildings b JOIN apartments a ON a.building_id = b.id WHERE a.id = $1',
      [apartmentId]
    );

    const buildingTimeout = buildingResult.rows[0]?.no_answer_timeout;
    if (buildingTimeout != null) {
      return normalizeRingTimeoutSec(buildingTimeout, fallbackTimeoutSec);
    }

    const globalResult = await queryFn(
      "SELECT value FROM global_settings WHERE key = 'no_answer_timeout'"
    );
    const globalTimeout = globalResult.rows[0]?.value;
    if (globalTimeout != null) {
      return normalizeRingTimeoutSec(globalTimeout, fallbackTimeoutSec);
    }
  } catch (err) {
    console.error(`[RING] Error resolving no_answer_timeout for apartment=${apartmentId}, using default ${fallbackTimeoutSec}s:`, err.message);
  }

  return fallbackTimeoutSec;
}

function getRingTimeoutMs(ringTimeoutSec) {
  return normalizeRingTimeoutSec(ringTimeoutSec) * 1000;
}

module.exports = {
  DEFAULT_RING_TIMEOUT_SEC,
  getRingTimeoutMs,
  resolveRingTimeoutSec,
};