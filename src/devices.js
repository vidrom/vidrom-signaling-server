// Device (intercom) provisioning — backed by PostgreSQL intercoms table
const { query } = require('./db');

async function validateProvisioningCode(code) {
  const result = await query(
    `UPDATE intercoms SET provisioning_status = 'active', provisioning_code = NULL
     WHERE provisioning_code = $1 AND provisioning_status = 'pending'
     RETURNING id AS "deviceId", building_id AS "buildingId", name, provisioning_status AS status`,
    [code]
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
  validateProvisioningCode,
  getDevice,
};
