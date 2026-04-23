// deviceHealthScore.js
// Helper for computing device health score and status inline

function computeDeviceHealth({
  lastPushFailed,
  lastAckAt,
  notificationPermission,
  hasAnyAck
}) {
  let score = 100;
  if (lastPushFailed) score -= 20;
  if (!lastAckAt) score -= 15;
  if (notificationPermission === 'denied') score -= 40;
  if (!hasAnyAck) score -= 10;
  score = Math.max(0, Math.min(100, score));
  let status = 'unknown';
  if (score >= 80) status = 'healthy';
  else if (score >= 50) status = 'degraded';
  else status = 'unhealthy';
  return { health_score: score, health_status: status };
}

module.exports = { computeDeviceHealth };
