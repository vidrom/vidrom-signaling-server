// Admin API routes — full CRUD for system administrators
const { query } = require('./db');

// ═══════════════════════════════════════════════════════════
// Buildings
// ═══════════════════════════════════════════════════════════

async function listBuildings(req, res) {
  const result = await query('SELECT * FROM buildings ORDER BY name');
  return result.rows;
}

async function createBuilding(body) {
  const { name, address, door_opening_time, no_answer_timeout, language, volume, brightness, dark_mode, sleep_mode } = body;
  if (!name || !address) {
    return { error: 'name and address are required', status: 400 };
  }
  const result = await query(
    `INSERT INTO buildings (name, address, door_opening_time, no_answer_timeout, language, volume, brightness, dark_mode, sleep_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [name, address, door_opening_time || 5, no_answer_timeout || 30, language || 'en', volume ?? 50, brightness ?? 50, dark_mode ?? false, sleep_mode ?? false]
  );
  return result.rows[0];
}

async function updateBuilding(id, body) {
  const fields = ['name', 'address', 'door_opening_time', 'no_answer_timeout', 'language', 'volume', 'brightness', 'dark_mode', 'sleep_mode'];
  const sets = [];
  const values = [];
  let idx = 1;
  for (const f of fields) {
    if (body[f] !== undefined) {
      sets.push(`${f} = $${idx++}`);
      values.push(body[f]);
    }
  }
  if (sets.length === 0) return { error: 'No fields to update', status: 400 };
  values.push(id);
  const result = await query(
    `UPDATE buildings SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (result.rows.length === 0) return { error: 'Building not found', status: 404 };
  return result.rows[0];
}

async function deleteBuilding(id) {
  const result = await query('DELETE FROM buildings WHERE id = $1 RETURNING id', [id]);
  if (result.rows.length === 0) return { error: 'Building not found', status: 404 };
  return { success: true };
}

// ═══════════════════════════════════════════════════════════
// Apartments
// ═══════════════════════════════════════════════════════════

async function listApartments(buildingId) {
  const result = await query(
    'SELECT a.*, b.name as building_name FROM apartments a JOIN buildings b ON a.building_id = b.id WHERE a.building_id = $1 ORDER BY a.number',
    [buildingId]
  );
  return result.rows;
}

async function createApartment(buildingId, body) {
  const { number, name } = body;
  if (!number) return { error: 'number is required', status: 400 };
  const result = await query(
    'INSERT INTO apartments (building_id, number, name) VALUES ($1, $2, $3) RETURNING *',
    [buildingId, number, name || null]
  );
  return result.rows[0];
}

async function updateApartment(id, body) {
  const fields = ['number', 'name'];
  const sets = [];
  const values = [];
  let idx = 1;
  for (const f of fields) {
    if (body[f] !== undefined) {
      sets.push(`${f} = $${idx++}`);
      values.push(body[f]);
    }
  }
  if (sets.length === 0) return { error: 'No fields to update', status: 400 };
  values.push(id);
  const result = await query(
    `UPDATE apartments SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (result.rows.length === 0) return { error: 'Apartment not found', status: 404 };
  return result.rows[0];
}

async function deleteApartment(id) {
  const result = await query('DELETE FROM apartments WHERE id = $1 RETURNING id', [id]);
  if (result.rows.length === 0) return { error: 'Apartment not found', status: 404 };
  return { success: true };
}

// ═══════════════════════════════════════════════════════════
// Users
// ═══════════════════════════════════════════════════════════

async function listUsers() {
  const result = await query('SELECT id, email, name, role, authentication_method, sleep_mode, created_at, updated_at FROM users ORDER BY name');
  return result.rows;
}

async function createUser(body) {
  const { email, name, role, authentication_method } = body;
  if (!email || !name || !role) return { error: 'email, name, and role are required', status: 400 };
  if (!['admin', 'manager', 'resident'].includes(role)) return { error: 'Invalid role', status: 400 };
  const result = await query(
    'INSERT INTO users (email, name, role, authentication_method) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role, authentication_method, sleep_mode, created_at',
    [email, name, role, authentication_method || null]
  );
  return result.rows[0];
}

async function updateUser(id, body) {
  const fields = ['email', 'name', 'role', 'authentication_method', 'sleep_mode'];
  const sets = [];
  const values = [];
  let idx = 1;
  for (const f of fields) {
    if (body[f] !== undefined) {
      sets.push(`${f} = $${idx++}`);
      values.push(body[f]);
    }
  }
  if (sets.length === 0) return { error: 'No fields to update', status: 400 };
  values.push(id);
  const result = await query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, email, name, role, authentication_method, sleep_mode, created_at, updated_at`,
    values
  );
  if (result.rows.length === 0) return { error: 'User not found', status: 404 };
  return result.rows[0];
}

async function deleteUser(id) {
  const result = await query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
  if (result.rows.length === 0) return { error: 'User not found', status: 404 };
  return { success: true };
}

// ═══════════════════════════════════════════════════════════
// Building Managers
// ═══════════════════════════════════════════════════════════

async function assignManager(buildingId, body) {
  const { user_id } = body;
  if (!user_id) return { error: 'user_id is required', status: 400 };
  // Verify user is a manager
  const userResult = await query('SELECT role FROM users WHERE id = $1', [user_id]);
  if (userResult.rows.length === 0) return { error: 'User not found', status: 404 };
  if (userResult.rows[0].role !== 'manager') return { error: 'User is not a manager', status: 400 };
  await query(
    'INSERT INTO building_managers (building_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [buildingId, user_id]
  );
  return { success: true };
}

async function removeManager(buildingId, userId) {
  const result = await query(
    'DELETE FROM building_managers WHERE building_id = $1 AND user_id = $2 RETURNING building_id',
    [buildingId, userId]
  );
  if (result.rows.length === 0) return { error: 'Assignment not found', status: 404 };
  return { success: true };
}

async function listBuildingManagers(buildingId) {
  const result = await query(
    `SELECT u.id, u.email, u.name, bm.created_at as assigned_at
     FROM building_managers bm JOIN users u ON bm.user_id = u.id
     WHERE bm.building_id = $1 ORDER BY u.name`,
    [buildingId]
  );
  return result.rows;
}

// ═══════════════════════════════════════════════════════════
// Apartment Residents
// ═══════════════════════════════════════════════════════════

async function assignResident(apartmentId, body) {
  const { user_id } = body;
  if (!user_id) return { error: 'user_id is required', status: 400 };
  const userResult = await query('SELECT role FROM users WHERE id = $1', [user_id]);
  if (userResult.rows.length === 0) return { error: 'User not found', status: 404 };
  if (userResult.rows[0].role !== 'resident') return { error: 'User is not a resident', status: 400 };
  await query(
    'INSERT INTO apartment_residents (apartment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [apartmentId, user_id]
  );
  return { success: true };
}

async function removeResident(apartmentId, userId) {
  const result = await query(
    'DELETE FROM apartment_residents WHERE apartment_id = $1 AND user_id = $2 RETURNING apartment_id',
    [apartmentId, userId]
  );
  if (result.rows.length === 0) return { error: 'Assignment not found', status: 404 };
  return { success: true };
}

async function listApartmentResidents(apartmentId) {
  const result = await query(
    `SELECT u.id, u.email, u.name, ar.created_at as assigned_at
     FROM apartment_residents ar JOIN users u ON ar.user_id = u.id
     WHERE ar.apartment_id = $1 ORDER BY u.name`,
    [apartmentId]
  );
  return result.rows;
}

// ═══════════════════════════════════════════════════════════
// Intercoms (Devices)
// ═══════════════════════════════════════════════════════════

async function listDevices() {
  const result = await query(
    `SELECT i.*, b.name as building_name FROM intercoms i
     JOIN buildings b ON i.building_id = b.id ORDER BY b.name, i.name`
  );
  return result.rows;
}

async function createDevice(body) {
  const { building_id, name, gate_id, door_code } = body;
  if (!building_id || !name) return { error: 'building_id and name are required', status: 400 };
  // Generate 6-digit provisioning code, stored in DB for persistent provisioning
  const provisioningCode = Math.floor(100000 + Math.random() * 900000).toString();
  const result = await query(
    'INSERT INTO intercoms (building_id, name, gate_id, door_code, provisioning_code, provisioning_status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [building_id, name, gate_id || null, door_code || null, provisioningCode, 'pending']
  );
  return result.rows[0];
}

async function updateDevice(id, body) {
  const fields = ['name', 'gate_id', 'door_code'];
  const sets = [];
  const values = [];
  let idx = 1;
  for (const f of fields) {
    if (body[f] !== undefined) {
      sets.push(`${f} = $${idx++}`);
      values.push(body[f]);
    }
  }
  if (sets.length === 0) return { error: 'No fields to update', status: 400 };
  values.push(id);
  const result = await query(
    `UPDATE intercoms SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (result.rows.length === 0) return { error: 'Intercom not found', status: 404 };
  return result.rows[0];
}

async function deleteDevice(id) {
  const result = await query('DELETE FROM intercoms WHERE id = $1 RETURNING id', [id]);
  if (result.rows.length === 0) return { error: 'Intercom not found', status: 404 };
  return { success: true };
}

async function revokeDevice(id) {
  const result = await query(
    "UPDATE intercoms SET status = 'disconnected', provisioning_status = 'revoked' WHERE id = $1 RETURNING *",
    [id]
  );
  if (result.rows.length === 0) return { error: 'Intercom not found', status: 404 };
  return { success: true };
}

async function reprovisionDevice(id) {
  const provisioningCode = Math.floor(100000 + Math.random() * 900000).toString();
  const result = await query(
    "UPDATE intercoms SET provisioning_status = 'pending', provisioning_code = $1 WHERE id = $2 RETURNING *",
    [provisioningCode, id]
  );
  if (result.rows.length === 0) return { error: 'Intercom not found', status: 404 };
  return { ...result.rows[0], provisioning_code: provisioningCode };
}

// ═══════════════════════════════════════════════════════════
// Notifications
// ═══════════════════════════════════════════════════════════

async function listNotifications() {
  const result = await query(
    `SELECT n.*, b.name as building_name FROM notifications n
     JOIN buildings b ON n.building_id = b.id ORDER BY n.created_at DESC`
  );
  return result.rows;
}

async function createNotification(body) {
  const { building_id, text } = body;
  if (!building_id || !text) return { error: 'building_id and text are required', status: 400 };
  const result = await query(
    'INSERT INTO notifications (building_id, text) VALUES ($1, $2) RETURNING *',
    [building_id, text]
  );
  return result.rows[0];
}

async function deleteNotification(id) {
  const result = await query('DELETE FROM notifications WHERE id = $1 RETURNING id', [id]);
  if (result.rows.length === 0) return { error: 'Notification not found', status: 404 };
  return { success: true };
}

// ═══════════════════════════════════════════════════════════
// Audit Logs
// ═══════════════════════════════════════════════════════════

async function listAuditLogs(queryParams) {
  const conditions = [];
  const values = [];
  let idx = 1;

  if (queryParams.event_type) {
    conditions.push(`al.event_type = $${idx++}`);
    values.push(queryParams.event_type);
  }
  if (queryParams.building_id) {
    conditions.push(`al.building_id = $${idx++}`);
    values.push(queryParams.building_id);
  }
  if (queryParams.user_id) {
    conditions.push(`al.user_id = $${idx++}`);
    values.push(queryParams.user_id);
  }
  if (queryParams.intercom_id) {
    conditions.push(`al.intercom_id = $${idx++}`);
    values.push(queryParams.intercom_id);
  }
  if (queryParams.from) {
    conditions.push(`al.created_at >= $${idx++}`);
    values.push(queryParams.from);
  }
  if (queryParams.to) {
    conditions.push(`al.created_at <= $${idx++}`);
    values.push(queryParams.to);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const result = await query(
    `SELECT al.*, b.name as building_name, u.name as user_name, ic.name as intercom_name
     FROM audit_logs al
     LEFT JOIN buildings b ON al.building_id = b.id
     LEFT JOIN users u ON al.user_id = u.id
     LEFT JOIN intercoms ic ON al.intercom_id = ic.id
     ${where}
     ORDER BY al.created_at DESC LIMIT 200`,
    values
  );
  return result.rows;
}

// ═══════════════════════════════════════════════════════════
// Client Errors
// ═══════════════════════════════════════════════════════════

async function listClientErrors(queryParams) {
  const conditions = [];
  const values = [];
  let idx = 1;

  if (queryParams.app) {
    conditions.push(`ce.app = $${idx++}`);
    values.push(queryParams.app);
  }
  if (queryParams.building_id) {
    conditions.push(`ce.building_id = $${idx++}`);
    values.push(queryParams.building_id);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const result = await query(
    `SELECT ce.*, b.name as building_name
     FROM client_errors ce
     LEFT JOIN buildings b ON ce.building_id = b.id
     ${where}
     ORDER BY ce.created_at DESC LIMIT 200`,
    values
  );
  return result.rows;
}

// ═══════════════════════════════════════════════════════════
// Global Settings
// ═══════════════════════════════════════════════════════════

async function listSettings() {
  const result = await query('SELECT * FROM global_settings ORDER BY key');
  return result.rows;
}

async function updateSetting(key, body) {
  const { value } = body;
  if (value === undefined) return { error: 'value is required', status: 400 };
  const result = await query(
    'UPDATE global_settings SET value = $1 WHERE key = $2 RETURNING *',
    [value, key]
  );
  if (result.rows.length === 0) return { error: 'Setting not found', status: 404 };
  return result.rows[0];
}

// ═══════════════════════════════════════════════════════════
// System Delivery Health
// ═══════════════════════════════════════════════════════════

async function getSystemDeliveryHealth() {
  // Delivery rate by building (last 7 days)
  const rateByBuilding = await query(
    `SELECT b.id AS building_id, b.name AS building_name,
            COUNT(*) AS total_calls,
            COUNT(*) FILTER (WHERE cds.devices_acked > 0) AS calls_with_ack
     FROM call_delivery_summary cds
     JOIN buildings b ON cds.building_id = b.id
     WHERE cds.call_started_at >= NOW() - INTERVAL '7 days'
     GROUP BY b.id, b.name
     ORDER BY b.name`
  );

  // Token health
  const tokenHealth = await query(
    `SELECT
       COUNT(*) AS total_tokens,
       COUNT(*) FILTER (WHERE dt.created_at < NOW() - INTERVAL '30 days') AS stale_tokens
     FROM device_tokens dt`
  );

  // Calls with delivery-degraded audit events
  const degradedResult = await query(
    `SELECT al.*, b.name AS building_name
     FROM audit_logs al
     LEFT JOIN buildings b ON al.building_id = b.id
     WHERE al.event_type = 'delivery-degraded'
       AND al.created_at >= NOW() - INTERVAL '7 days'
     ORDER BY al.created_at DESC LIMIT 50`
  );

  // Retry effectiveness: % of retried devices that eventually acked
  const retryResult = await query(
    `SELECT
       COUNT(DISTINCT (cda.call_id, cda.device_token)) FILTER (WHERE cda.attempt_number > 1) AS retried_devices,
       COUNT(DISTINCT (cda.call_id, cda.device_token)) FILTER (
         WHERE cda.attempt_number > 1 AND cda.delivery_state IN ('push-received', 'app-awake', 'incoming-ui-shown', 'accepted')
       ) AS retried_and_acked
     FROM call_delivery_attempts cda
     JOIN calls c ON cda.call_id = c.id
     WHERE c.created_at >= NOW() - INTERVAL '7 days'`
  );
  const retry = retryResult.rows[0];

  return {
    rate_by_building: rateByBuilding.rows.map(r => ({
      ...r,
      delivery_rate: r.total_calls > 0 ? Math.round((r.calls_with_ack / r.total_calls) * 100) : null,
    })),
    token_health: tokenHealth.rows[0],
    degraded_calls: degradedResult.rows,
    retry_effectiveness: {
      retried_devices: parseInt(retry.retried_devices),
      retried_and_acked: parseInt(retry.retried_and_acked),
      effectiveness_pct: retry.retried_devices > 0
        ? Math.round((retry.retried_and_acked / retry.retried_devices) * 100)
        : null,
    },
  };
}

module.exports = {
  listBuildings, createBuilding, updateBuilding, deleteBuilding,
  listApartments, createApartment, updateApartment, deleteApartment,
  listUsers, createUser, updateUser, deleteUser,
  assignManager, removeManager, listBuildingManagers,
  assignResident, removeResident, listApartmentResidents,
  listDevices, createDevice, updateDevice, deleteDevice, revokeDevice, reprovisionDevice,
  listNotifications, createNotification, deleteNotification,
  listAuditLogs,
  listClientErrors,
  listSettings, updateSetting,
  getSystemDeliveryHealth,
};
