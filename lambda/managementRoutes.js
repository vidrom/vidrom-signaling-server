// Management API routes — scoped CRUD for building managers
const { query } = require('./db');

// Helper: check if a building belongs to the manager's assigned buildings
function assertBuilding(buildingIds, buildingId) {
  if (!buildingIds.includes(buildingId)) {
    return { error: 'Forbidden — building not assigned to you', status: 403 };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// Buildings (read + edit settings only)
// ═══════════════════════════════════════════════════════════

async function listBuildings(buildingIds) {
  if (buildingIds.length === 0) return [];
  const result = await query(
    'SELECT * FROM buildings WHERE id = ANY($1::uuid[]) ORDER BY name',
    [buildingIds]
  );
  return result.rows;
}

async function updateBuilding(buildingIds, id, body) {
  const err = assertBuilding(buildingIds, id);
  if (err) return err;
  // Managers can only update settings, NOT name/address
  const fields = ['door_opening_time', 'no_answer_timeout', 'language', 'volume', 'brightness', 'dark_mode', 'sleep_mode'];
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

// ═══════════════════════════════════════════════════════════
// Apartments
// ═══════════════════════════════════════════════════════════

async function listApartments(buildingIds, buildingId) {
  const err = assertBuilding(buildingIds, buildingId);
  if (err) return err;
  const result = await query(
    'SELECT a.*, b.name as building_name FROM apartments a JOIN buildings b ON a.building_id = b.id WHERE a.building_id = $1 ORDER BY a.number',
    [buildingId]
  );
  return result.rows;
}

async function createApartment(buildingIds, buildingId, body) {
  const err = assertBuilding(buildingIds, buildingId);
  if (err) return err;
  const { number, name } = body;
  if (!number) return { error: 'number is required', status: 400 };
  const result = await query(
    'INSERT INTO apartments (building_id, number, name) VALUES ($1, $2, $3) RETURNING *',
    [buildingId, number, name || null]
  );
  return result.rows[0];
}

async function updateApartment(buildingIds, id, body) {
  // Verify apartment belongs to assigned building
  const aptResult = await query('SELECT building_id FROM apartments WHERE id = $1', [id]);
  if (aptResult.rows.length === 0) return { error: 'Apartment not found', status: 404 };
  const err = assertBuilding(buildingIds, aptResult.rows[0].building_id);
  if (err) return err;

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
  return result.rows[0];
}

async function deleteApartment(buildingIds, id) {
  const aptResult = await query('SELECT building_id FROM apartments WHERE id = $1', [id]);
  if (aptResult.rows.length === 0) return { error: 'Apartment not found', status: 404 };
  const err = assertBuilding(buildingIds, aptResult.rows[0].building_id);
  if (err) return err;
  await query('DELETE FROM apartments WHERE id = $1', [id]);
  return { success: true };
}

// ═══════════════════════════════════════════════════════════
// Residents
// ═══════════════════════════════════════════════════════════

async function listResidents(buildingIds, apartmentId) {
  // Verify apartment belongs to assigned building
  const aptResult = await query('SELECT building_id FROM apartments WHERE id = $1', [apartmentId]);
  if (aptResult.rows.length === 0) return { error: 'Apartment not found', status: 404 };
  const err = assertBuilding(buildingIds, aptResult.rows[0].building_id);
  if (err) return err;

  const result = await query(
    `SELECT u.id, u.email, u.name, ar.created_at as assigned_at
     FROM apartment_residents ar JOIN users u ON ar.user_id = u.id
     WHERE ar.apartment_id = $1 ORDER BY u.name`,
    [apartmentId]
  );
  return result.rows;
}

async function assignResident(buildingIds, apartmentId, body) {
  const aptResult = await query('SELECT building_id FROM apartments WHERE id = $1', [apartmentId]);
  if (aptResult.rows.length === 0) return { error: 'Apartment not found', status: 404 };
  const err = assertBuilding(buildingIds, aptResult.rows[0].building_id);
  if (err) return err;

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

async function removeResident(buildingIds, apartmentId, userId) {
  const aptResult = await query('SELECT building_id FROM apartments WHERE id = $1', [apartmentId]);
  if (aptResult.rows.length === 0) return { error: 'Apartment not found', status: 404 };
  const err = assertBuilding(buildingIds, aptResult.rows[0].building_id);
  if (err) return err;

  const result = await query(
    'DELETE FROM apartment_residents WHERE apartment_id = $1 AND user_id = $2 RETURNING apartment_id',
    [apartmentId, userId]
  );
  if (result.rows.length === 0) return { error: 'Assignment not found', status: 404 };
  return { success: true };
}

// ═══════════════════════════════════════════════════════════
// Intercoms (Devices)
// ═══════════════════════════════════════════════════════════

async function listDevices(buildingIds) {
  if (buildingIds.length === 0) return [];
  const result = await query(
    `SELECT i.*, b.name as building_name FROM intercoms i
     JOIN buildings b ON i.building_id = b.id
     WHERE i.building_id = ANY($1::uuid[]) ORDER BY b.name, i.name`,
    [buildingIds]
  );
  return result.rows;
}

async function createDevice(buildingIds, body) {
  const { building_id, name, gate_id } = body;
  if (!building_id || !name) return { error: 'building_id and name are required', status: 400 };
  const err = assertBuilding(buildingIds, building_id);
  if (err) return err;
  const provisioningCode = Math.floor(100000 + Math.random() * 900000).toString();
  const result = await query(
    'INSERT INTO intercoms (building_id, name, gate_id) VALUES ($1, $2, $3) RETURNING *',
    [building_id, name, gate_id || null]
  );
  return { ...result.rows[0], provisioning_code: provisioningCode };
}

async function revokeDevice(buildingIds, id) {
  const devResult = await query('SELECT building_id FROM intercoms WHERE id = $1', [id]);
  if (devResult.rows.length === 0) return { error: 'Intercom not found', status: 404 };
  const err = assertBuilding(buildingIds, devResult.rows[0].building_id);
  if (err) return err;
  await query("UPDATE intercoms SET status = 'disconnected' WHERE id = $1", [id]);
  return { success: true };
}

async function reprovisionDevice(buildingIds, id) {
  const devResult = await query('SELECT building_id FROM intercoms WHERE id = $1', [id]);
  if (devResult.rows.length === 0) return { error: 'Intercom not found', status: 404 };
  const err = assertBuilding(buildingIds, devResult.rows[0].building_id);
  if (err) return err;
  const provisioningCode = Math.floor(100000 + Math.random() * 900000).toString();
  const result = await query(
    "UPDATE intercoms SET provisioning_status = 'pending', provisioning_code = $1 WHERE id = $2 RETURNING *",
    [provisioningCode, id]
  );
  return { ...result.rows[0], provisioning_code: provisioningCode };
}

// ═══════════════════════════════════════════════════════════
// Notifications
// ═══════════════════════════════════════════════════════════

async function listNotifications(buildingIds) {
  if (buildingIds.length === 0) return [];
  const result = await query(
    `SELECT n.*, b.name as building_name FROM notifications n
     JOIN buildings b ON n.building_id = b.id
     WHERE n.building_id = ANY($1::uuid[]) ORDER BY n.created_at DESC`,
    [buildingIds]
  );
  return result.rows;
}

async function createNotification(buildingIds, body) {
  const { building_id, text } = body;
  if (!building_id || !text) return { error: 'building_id and text are required', status: 400 };
  const err = assertBuilding(buildingIds, building_id);
  if (err) return err;
  const result = await query(
    'INSERT INTO notifications (building_id, text) VALUES ($1, $2) RETURNING *',
    [building_id, text]
  );
  return result.rows[0];
}

async function deleteNotification(buildingIds, id) {
  const notifResult = await query('SELECT building_id FROM notifications WHERE id = $1', [id]);
  if (notifResult.rows.length === 0) return { error: 'Notification not found', status: 404 };
  const err = assertBuilding(buildingIds, notifResult.rows[0].building_id);
  if (err) return err;
  await query('DELETE FROM notifications WHERE id = $1', [id]);
  return { success: true };
}

// ═══════════════════════════════════════════════════════════
// Audit Logs (read-only)
// ═══════════════════════════════════════════════════════════

async function listAuditLogs(buildingIds, queryParams) {
  if (buildingIds.length === 0) return [];
  const conditions = ['al.building_id = ANY($1::uuid[])'];
  const values = [buildingIds];
  let idx = 2;

  if (queryParams.event_type) {
    conditions.push(`al.event_type = $${idx++}`);
    values.push(queryParams.event_type);
  }
  if (queryParams.building_id) {
    conditions.push(`al.building_id = $${idx++}`);
    values.push(queryParams.building_id);
  }
  if (queryParams.from) {
    conditions.push(`al.created_at >= $${idx++}`);
    values.push(queryParams.from);
  }
  if (queryParams.to) {
    conditions.push(`al.created_at <= $${idx++}`);
    values.push(queryParams.to);
  }

  const where = 'WHERE ' + conditions.join(' AND ');
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
// Delivery Health (read-only)
// ═══════════════════════════════════════════════════════════

async function getDeliveryHealth(buildingIds, queryParams) {
  if (buildingIds.length === 0) return { recent_calls: [], delivery_rate: null, avg_latency: null, failed_deliveries: [], unhealthy_apartments: [] };

  // Recent calls with delivery breakdown
  const recentCalls = await query(
    `SELECT cds.call_id, cds.building_id, cds.apartment_id, cds.call_status,
            cds.call_started_at, cds.call_ended_at,
            cds.devices_targeted, cds.devices_acked, cds.devices_failed,
            cds.devices_timed_out, cds.devices_skipped_sleep, cds.max_retries,
            cds.first_ack_latency_sec,
            b.name AS building_name, a.number AS apartment_number
     FROM call_delivery_summary cds
     JOIN buildings b ON cds.building_id = b.id
     LEFT JOIN apartments a ON cds.apartment_id = a.id
     WHERE cds.building_id = ANY($1::uuid[])
     ORDER BY cds.call_started_at DESC LIMIT 50`,
    [buildingIds]
  );

  // Delivery rate over last 7 days
  const rateResult = await query(
    `SELECT
       COUNT(*) AS total_calls,
       COUNT(*) FILTER (WHERE devices_acked > 0) AS calls_with_ack
     FROM call_delivery_summary
     WHERE building_id = ANY($1::uuid[]) AND call_started_at >= NOW() - INTERVAL '7 days'`,
    [buildingIds]
  );
  const rate = rateResult.rows[0];
  const deliveryRate = rate.total_calls > 0
    ? Math.round((rate.calls_with_ack / rate.total_calls) * 100)
    : null;

  // Average ack latency by platform
  const latencyResult = await query(
    `SELECT cda.platform,
            ROUND(AVG(EXTRACT(EPOCH FROM (cdacks.created_at - c.created_at)))::numeric, 2) AS avg_latency_sec
     FROM call_delivery_acks cdacks
     JOIN calls c ON cdacks.call_id = c.id
     JOIN call_delivery_attempts cda ON cda.call_id = cdacks.call_id AND cda.device_token = cdacks.device_token
     WHERE c.building_id = ANY($1::uuid[])
       AND c.created_at >= NOW() - INTERVAL '7 days'
       AND cdacks.event = 'push-received'
     GROUP BY cda.platform`,
    [buildingIds]
  );

  // Failed deliveries grouped by error
  const failedResult = await query(
    `SELECT cda.last_error, COUNT(*) AS count
     FROM call_delivery_attempts cda
     JOIN calls c ON cda.call_id = c.id
     WHERE c.building_id = ANY($1::uuid[])
       AND cda.delivery_state = 'push-failed'
       AND c.created_at >= NOW() - INTERVAL '7 days'
     GROUP BY cda.last_error
     ORDER BY count DESC LIMIT 20`,
    [buildingIds]
  );

  // Apartments with no healthy tokens
  const unhealthyResult = await query(
    `SELECT a.id, a.number, a.name, b.name AS building_name
     FROM apartments a
     JOIN buildings b ON a.building_id = b.id
     WHERE a.building_id = ANY($1::uuid[])
       AND NOT EXISTS (
         SELECT 1 FROM device_tokens dt WHERE dt.apartment_id = a.id
       )`,
    [buildingIds]
  );

  return {
    recent_calls: recentCalls.rows,
    delivery_rate: deliveryRate,
    total_calls_7d: parseInt(rate.total_calls),
    calls_with_ack_7d: parseInt(rate.calls_with_ack),
    avg_latency: latencyResult.rows,
    failed_deliveries: failedResult.rows,
    unhealthy_apartments: unhealthyResult.rows,
  };
}

async function getDeviceHealth(buildingIds, buildingId) {
  const err = assertBuilding(buildingIds, buildingId);
  if (err) return err;

  const result = await query(
    `SELECT apartment_id, apartment_number, building_id,
            total_devices, healthy_devices, degraded_devices, unhealthy_devices,
            apartment_health
     FROM apartment_device_health
     WHERE building_id = $1
     ORDER BY apartment_number`,
    [buildingId]
  );
  return result.rows;
}

module.exports = {
  listBuildings, updateBuilding,
  listApartments, createApartment, updateApartment, deleteApartment,
  listResidents, assignResident, removeResident,
  listDevices, createDevice, revokeDevice, reprovisionDevice,
  listNotifications, createNotification, deleteNotification,
  listAuditLogs,
  getDeliveryHealth,
  getDeviceHealth,
};
