// Device (intercom) provisioning — backed by PostgreSQL intercoms table
const { query } = require('./db');

function getProvisioningTtlHours() {
  const value = Number.parseInt(process.env.PROVISIONING_CODE_TTL_HOURS || '24', 10);
  return Number.isFinite(value) && value > 0 ? value : 24;
}

async function validateProvisioningCode(code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
    return null;
  }
  const ttlHours = getProvisioningTtlHours();
  const result = await query(
    `UPDATE intercoms SET provisioning_status = 'active', provisioning_code = NULL
     WHERE provisioning_code = $1
       AND provisioning_status = 'pending'
       AND updated_at >= NOW() - ($2::text || ' hours')::interval
     RETURNING id AS "deviceId", building_id AS "buildingId", name, provisioning_status AS status`,
    [code.trim(), ttlHours]
  );
  return result.rows[0] || null;
}

async function getDevice(deviceId) {
  const result = await query(
    `SELECT id AS "deviceId", building_id AS "buildingId", name, provisioning_status AS status
     FROM intercoms WHERE id = $1`,
    [deviceId]
  );
  return result.rows[0] || null;
}

module.exports = {
  getProvisioningTtlHours,
  validateProvisioningCode,
  getDevice,
};
