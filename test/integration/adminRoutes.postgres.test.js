const test = require('node:test');
const assert = require('node:assert/strict');

const { requireWithMocks } = require('../wsTestHarness');
const { canRunPostgresIntegration, startPostgresHarness } = require('./postgresHarness');
const { IDS, resetCoreTables } = require('./postgresFixtures');

let dockerAvailable;
let harness;

test.before(async () => {
  dockerAvailable = await canRunPostgresIntegration();
  if (!dockerAvailable) return;
  harness = await startPostgresHarness();
});

test.after(async () => {
  if (harness) {
    await harness.close();
  }
});

function loadAdminRoutes() {
  return requireWithMocks('../../lambda/adminRoutes', {
    './db': {
      query: harness.query.bind(harness),
    },
  });
}

const IDS_EXTRA = {
  apartment3: '44444444-4444-4444-4444-444444444445',
  manager2: '66666666-6666-6666-6666-666666666667',
  resident2: '55555555-5555-5555-5555-555555555556',
  admin2: '99999999-9999-9999-9999-999999999993',
  intercom2: '77777777-7777-7777-7777-777777777778',
  intercom3: '77777777-7777-7777-7777-777777777779',
  call2: '88888888-8888-8888-8888-888888888889',
  call3: '88888888-8888-8888-8888-888888888890',
};

async function seedAdminFixture() {
  await resetCoreTables(harness);

  await harness.query(
    `INSERT INTO buildings (id, name, address)
     VALUES ($1, 'Admin Building', '1 Main St'),
            ($2, 'Second Building', '2 Main St')`,
    [IDS.building1, IDS.building2]
  );
  await harness.query(
    `INSERT INTO apartments (id, building_id, number, name)
     VALUES ($1, $2, '12A', 'Unit 12A'),
            ($3, $4, '21B', 'Unit 21B')`,
    [IDS.apartment1, IDS.building1, IDS.apartment2, IDS.building2]
  );
  await harness.query(
    `INSERT INTO users (id, email, name, role)
     VALUES ($1, 'manager@example.com', 'Manager One', 'manager'),
            ($2, 'resident@example.com', 'Resident One', 'resident')`,
    [IDS.operatorUser, IDS.residentUser]
  );
}

test('PostgreSQL-backed admin building CRUD and settings update persist through the real schema', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedAdminFixture();
  const adminRoutes = loadAdminRoutes();

  const created = await adminRoutes.createBuilding({
    name: 'Created Building',
    address: '3 Main St',
    no_answer_timeout: 45,
    volume: 70,
  });

  assert.equal(created.name, 'Created Building');
  assert.equal(created.address, '3 Main St');
  assert.equal(created.no_answer_timeout, 45);
  assert.equal(created.volume, 70);

  const updated = await adminRoutes.updateBuilding(created.id, {
    brightness: 22,
    dark_mode: true,
  });

  assert.equal(updated.id, created.id);
  assert.equal(updated.brightness, 22);
  assert.equal(updated.dark_mode, true);

  const setting = await adminRoutes.updateSetting('no_answer_timeout', { value: '55' });
  assert.equal(setting.key, 'no_answer_timeout');
  assert.equal(setting.value, '55');

  const deleted = await adminRoutes.deleteBuilding(created.id);
  assert.deepEqual(deleted, { success: true });

  const buildingRows = await harness.query(
    `SELECT id FROM buildings WHERE id = $1`,
    [created.id]
  );
  assert.deepEqual(buildingRows.rows, []);

  const settingsRows = await harness.query(
    `SELECT key, value FROM global_settings WHERE key = 'no_answer_timeout'`
  );
  assert.deepEqual(settingsRows.rows, [
    {
      key: 'no_answer_timeout',
      value: '55',
    },
  ]);
});

test('PostgreSQL-backed admin manager and resident assignment validate role and persist join rows', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedAdminFixture();
  const adminRoutes = loadAdminRoutes();

  const managerResult = await adminRoutes.assignManager(IDS.building1, {
    user_id: IDS.operatorUser,
  });
  assert.deepEqual(managerResult, { success: true });

  const wrongManagerRole = await adminRoutes.assignManager(IDS.building1, {
    user_id: IDS.residentUser,
  });
  assert.deepEqual(wrongManagerRole, {
    error: 'User is not a manager',
    status: 400,
  });

  const residentResult = await adminRoutes.assignResident(IDS.apartment1, {
    user_id: IDS.residentUser,
  });
  assert.deepEqual(residentResult, { success: true });

  const wrongResidentRole = await adminRoutes.assignResident(IDS.apartment1, {
    user_id: IDS.operatorUser,
  });
  assert.deepEqual(wrongResidentRole, {
    error: 'User is not a resident',
    status: 400,
  });

  const managerRows = await harness.query(
    `SELECT building_id, user_id FROM building_managers WHERE building_id = $1 AND user_id = $2`,
    [IDS.building1, IDS.operatorUser]
  );
  assert.deepEqual(managerRows.rows, [
    {
      building_id: IDS.building1,
      user_id: IDS.operatorUser,
    },
  ]);

  const residentRows = await harness.query(
    `SELECT apartment_id, user_id FROM apartment_residents WHERE apartment_id = $1 AND user_id = $2`,
    [IDS.apartment1, IDS.residentUser]
  );
  assert.deepEqual(residentRows.rows, [
    {
      apartment_id: IDS.apartment1,
      user_id: IDS.residentUser,
    },
  ]);
});

test('PostgreSQL-backed admin device lifecycle writes real provisioning and door-code state', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedAdminFixture();
  const adminRoutes = loadAdminRoutes();

  const created = await adminRoutes.createDevice({
    building_id: IDS.building1,
    name: 'Lobby Intercom',
    gate_id: 'gate-1',
    door_code: ' 1234 ',
  });

  assert.equal(created.building_id, IDS.building1);
  assert.equal(created.name, 'Lobby Intercom');
  assert.equal(created.gate_id, 'gate-1');
  assert.equal(created.door_code, null);
  assert.equal(created.provisioning_status, 'pending');
  assert.match(created.provisioning_code, /^\d{6}$/);

  const insertedRows = await harness.query(
    `SELECT id, door_code, door_code_hash, provisioning_status, provisioning_code
     FROM intercoms
     WHERE id = $1`,
    [created.id]
  );
  assert.equal(insertedRows.rows[0].door_code, null);
  assert.match(insertedRows.rows[0].door_code_hash, /^pbkdf2_sha256\$/);
  assert.equal(insertedRows.rows[0].provisioning_status, 'pending');
  assert.equal(insertedRows.rows[0].provisioning_code, created.provisioning_code);

  const firstDoorCodeHash = insertedRows.rows[0].door_code_hash;

  const updated = await adminRoutes.updateDevice(created.id, {
    name: 'Updated Intercom',
    gate_id: 'gate-2',
    door_code: '5678',
  });

  assert.equal(updated.name, 'Updated Intercom');
  assert.equal(updated.gate_id, 'gate-2');
  assert.equal(updated.door_code, null);

  const updatedRows = await harness.query(
    `SELECT name, gate_id, door_code, door_code_hash
     FROM intercoms
     WHERE id = $1`,
    [created.id]
  );
  assert.deepEqual(updatedRows.rows[0].name, 'Updated Intercom');
  assert.deepEqual(updatedRows.rows[0].gate_id, 'gate-2');
  assert.equal(updatedRows.rows[0].door_code, null);
  assert.match(updatedRows.rows[0].door_code_hash, /^pbkdf2_sha256\$/);
  assert.notEqual(updatedRows.rows[0].door_code_hash, firstDoorCodeHash);

  const revoked = await adminRoutes.revokeDevice(created.id);
  assert.deepEqual(revoked, { success: true });

  const reprovisioned = await adminRoutes.reprovisionDevice(created.id);
  assert.equal(reprovisioned.id, created.id);
  assert.equal(reprovisioned.provisioning_status, 'pending');
  assert.match(reprovisioned.provisioning_code, /^\d{6}$/);

  const finalRows = await harness.query(
    `SELECT status, provisioning_status, provisioning_code
     FROM intercoms
     WHERE id = $1`,
    [created.id]
  );
  assert.deepEqual(finalRows.rows, [
    {
      status: 'disconnected',
      provisioning_status: 'pending',
      provisioning_code: reprovisioned.provisioning_code,
    },
  ]);
});

test('PostgreSQL-backed admin notification CRUD persists against the real schema', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedAdminFixture();
  const adminRoutes = loadAdminRoutes();

  const created = await adminRoutes.createNotification({
    building_id: IDS.building1,
    text: 'System maintenance tonight',
  });

  assert.equal(created.building_id, IDS.building1);
  assert.equal(created.text, 'System maintenance tonight');

  const listed = await adminRoutes.listNotifications();
  assert.equal(listed.some((row) => row.id === created.id && row.building_name === 'Admin Building'), true);

  const deleted = await adminRoutes.deleteNotification(created.id);
  assert.deepEqual(deleted, { success: true });

  const notificationRows = await harness.query(
    `SELECT id FROM notifications WHERE id = $1`,
    [created.id]
  );
  assert.deepEqual(notificationRows.rows, []);
});

test('PostgreSQL-backed admin audit and client-error queries honor filters against the real schema', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedAdminFixture();
  const adminRoutes = loadAdminRoutes();

  await harness.query(
    `INSERT INTO intercoms (id, building_id, name, provisioning_status)
     VALUES ($1, $2, 'Lobby Intercom', 'active'),
            ($3, $4, 'Rear Intercom', 'active')`,
    [IDS.intercom1, IDS.building1, IDS_EXTRA.intercom2, IDS.building2]
  );
  await harness.query(
    `INSERT INTO audit_logs (id, event_type, building_id, apartment_id, user_id, intercom_id, description, created_at)
     VALUES
       ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'delivery-degraded', $1, $2, $3, $4, 'Keep me', NOW() - INTERVAL '1 day'),
       ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', 'door-open', $1, $2, $3, $4, 'Wrong event', NOW() - INTERVAL '2 hours'),
       ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', 'delivery-degraded', $5, $6, $7, $8, 'Wrong building', NOW() - INTERVAL '1 day')`,
    [
      IDS.building1,
      IDS.apartment1,
      IDS.residentUser,
      IDS.intercom1,
      IDS.building2,
      IDS.apartment2,
      IDS.operatorUser,
      IDS_EXTRA.intercom2,
    ]
  );
  await harness.query(
    `INSERT INTO client_errors (
       id, app, error_type, message, platform, building_id, apartment_id, user_id, user_email, intercom_id, created_at
     ) VALUES
       ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'home', 'media', 'Keep home error', 'ios', $1, $2, $3, 'resident@example.com', $4, NOW() - INTERVAL '30 minutes'),
       ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', 'intercom', 'network', 'Wrong app', 'android', $1, $2, $3, 'resident@example.com', $4, NOW() - INTERVAL '20 minutes'),
       ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3', 'home', 'media', 'Wrong building', 'android', $5, $6, $7, 'manager@example.com', $8, NOW() - INTERVAL '10 minutes')`,
    [
      IDS.building1,
      IDS.apartment1,
      IDS.residentUser,
      IDS.intercom1,
      IDS.building2,
      IDS.apartment2,
      IDS.operatorUser,
      IDS_EXTRA.intercom2,
    ]
  );

  const auditRows = await adminRoutes.listAuditLogs({
    event_type: 'delivery-degraded',
    building_id: IDS.building1,
    user_id: IDS.residentUser,
    intercom_id: IDS.intercom1,
    from: '2000-01-01T00:00:00.000Z',
    to: '2100-01-01T00:00:00.000Z',
  });
  const clientErrorRows = await adminRoutes.listClientErrors({
    app: 'home',
    building_id: IDS.building1,
  });

  assert.deepEqual(
    auditRows.map((row) => ({
      event_type: row.event_type,
      building_id: row.building_id,
      building_name: row.building_name,
      user_name: row.user_name,
      intercom_name: row.intercom_name,
      description: row.description,
    })),
    [
      {
        event_type: 'delivery-degraded',
        building_id: IDS.building1,
        building_name: 'Admin Building',
        user_name: 'Resident One',
        intercom_name: 'Lobby Intercom',
        description: 'Keep me',
      },
    ]
  );
  assert.deepEqual(
    clientErrorRows.map((row) => ({
      app: row.app,
      building_id: row.building_id,
      building_name: row.building_name,
      user_email: row.user_email,
      message: row.message,
    })),
    [
      {
        app: 'home',
        building_id: IDS.building1,
        building_name: 'Admin Building',
        user_email: 'resident@example.com',
        message: 'Keep home error',
      },
    ]
  );
});

test('PostgreSQL-backed admin delivery health rolls up real view data and retry effectiveness', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedAdminFixture();
  const adminRoutes = loadAdminRoutes();

  await harness.query(
    `INSERT INTO intercoms (id, building_id, name, provisioning_status)
     VALUES ($1, $2, 'Lobby Intercom', 'active'),
            ($3, $4, 'Rear Intercom', 'active')`,
    [IDS.intercom1, IDS.building1, IDS_EXTRA.intercom2, IDS.building2]
  );
  await harness.query(
    `INSERT INTO calls (id, building_id, apartment_id, intercom_id, status, created_at, ended_at)
     VALUES
       ($1, $2, $3, $4, 'accepted', NOW() - INTERVAL '1 day', NOW() - INTERVAL '23 hours'),
       ($5, $2, $3, $4, 'unanswered', NOW() - INTERVAL '2 days', NOW() - INTERVAL '47 hours'),
       ($6, $7, $8, $9, 'ended', NOW() - INTERVAL '3 days', NOW() - INTERVAL '71 hours')`,
    [
      IDS.call1,
      IDS.building1,
      IDS.apartment1,
      IDS.intercom1,
      IDS_EXTRA.call2,
      IDS_EXTRA.call3,
      IDS.building2,
      IDS.apartment2,
      IDS_EXTRA.intercom2,
    ]
  );
  await harness.query(
    `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, created_at, updated_at)
     VALUES
       ($1, $2, 'fresh-token', 'fcm', 'ios', NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day'),
       ($1, $2, 'stale-token-1', 'voip', 'ios', NOW() - INTERVAL '40 days', NOW() - INTERVAL '1 day'),
       ($3, $4, 'stale-token-2', 'fcm', 'android', NOW() - INTERVAL '31 days', NOW() - INTERVAL '1 day')`,
    [IDS.apartment1, IDS.residentUser, IDS.apartment2, IDS.operatorUser]
  );
  await harness.query(
    `INSERT INTO call_delivery_attempts (
       call_id, user_id, device_token, token_type, platform, attempt_number, delivery_state, last_attempt_at, acked_at
     ) VALUES
       ($1, $2, 'fresh-token', 'fcm', 'ios', 1, 'push-sent', NOW() - INTERVAL '1 day', NULL),
       ($1, $2, 'fresh-token', 'fcm', 'ios', 2, 'push-received', NOW() - INTERVAL '23 hours 59 minutes', NOW() - INTERVAL '23 hours 59 minutes'),
       ($1, $2, 'stale-token-1', 'voip', 'ios', 1, 'push-sent', NOW() - INTERVAL '1 day', NULL),
       ($1, $2, 'stale-token-1', 'voip', 'ios', 2, 'push-failed', NOW() - INTERVAL '23 hours 58 minutes', NULL),
       ($3, $2, 'timeout-token', 'fcm', 'ios', 1, 'timed-out', NOW() - INTERVAL '2 days', NULL),
       ($4, $5, 'other-building-token', 'fcm', 'android', 1, 'push-sent', NOW() - INTERVAL '3 days', NULL),
       ($4, $5, 'other-building-token', 'fcm', 'android', 2, 'accepted', NOW() - INTERVAL '71 hours 58 minutes', NOW() - INTERVAL '71 hours 58 minutes')`,
    [
      IDS.call1,
      IDS.residentUser,
      IDS_EXTRA.call2,
      IDS_EXTRA.call3,
      IDS.operatorUser,
    ]
  );
  await harness.query(
    `INSERT INTO call_delivery_acks (call_id, user_id, device_token, token_type, platform, event, created_at)
     VALUES
       ($1, $2, 'fresh-token', 'fcm', 'ios', 'push-received', NOW() - INTERVAL '23 hours 59 minutes'),
       ($3, $4, 'other-building-token', 'fcm', 'android', 'push-received', NOW() - INTERVAL '71 hours 58 minutes')`,
    [IDS.call1, IDS.residentUser, IDS_EXTRA.call3, IDS.operatorUser]
  );
  await harness.query(
    `INSERT INTO audit_logs (id, event_type, building_id, apartment_id, user_id, intercom_id, call_id, description, created_at)
     VALUES
       ('cccccccc-cccc-cccc-cccc-ccccccccccc1', 'delivery-degraded', $1, $2, $3, $4, $5, 'Recent degraded call', NOW() - INTERVAL '1 day'),
       ('cccccccc-cccc-cccc-cccc-ccccccccccc2', 'delivery-degraded', $1, $2, $3, $4, $5, 'Too old', NOW() - INTERVAL '8 days')`,
    [IDS.building1, IDS.apartment1, IDS.residentUser, IDS.intercom1, IDS.call1]
  );

  const result = await adminRoutes.getSystemDeliveryHealth();

  assert.deepEqual(result.rate_by_building, [
    {
      building_id: IDS.building1,
      building_name: 'Admin Building',
      total_calls: '2',
      calls_with_ack: '1',
      delivery_rate: 50,
    },
    {
      building_id: IDS.building2,
      building_name: 'Second Building',
      total_calls: '1',
      calls_with_ack: '1',
      delivery_rate: 100,
    },
  ]);
  assert.deepEqual(result.token_health, {
    total_tokens: '3',
    stale_tokens: '2',
  });
  assert.deepEqual(
    result.degraded_calls.map((row) => ({
      building_id: row.building_id,
      building_name: row.building_name,
      description: row.description,
    })),
    [
      {
        building_id: IDS.building1,
        building_name: 'Admin Building',
        description: 'Recent degraded call',
      },
    ]
  );
  assert.deepEqual(result.retry_effectiveness, {
    retried_devices: 3,
    retried_and_acked: 2,
    effectiveness_pct: 67,
  });
});

test('PostgreSQL-backed admin device health summary aggregates real apartment health view rows', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedAdminFixture();
  const adminRoutes = loadAdminRoutes();

  await harness.query(
    `INSERT INTO apartments (id, building_id, number, name)
     VALUES ($1, $2, '22C', 'Unit 22C')`,
    [IDS_EXTRA.apartment3, IDS.building2]
  );
  await harness.query(
    `INSERT INTO device_health (
       device_token, user_id, apartment_id, platform, token_type,
       last_successful_push, last_token_refresh, health_score
     ) VALUES
       ('healthy-device', $1, $2, 'ios', 'fcm', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', 95),
       ('unhealthy-device-1', $1, $2, 'ios', 'voip', NOW() - INTERVAL '8 days', NOW() - INTERVAL '10 days', 70),
       ('degraded-device', $3, $4, 'android', 'fcm', NOW() - INTERVAL '1 day', NOW() - INTERVAL '40 days', 60),
       ('unhealthy-device-2', $3, $5, 'android', 'voip', NOW() - INTERVAL '20 days', NOW() - INTERVAL '40 days', 40)`,
    [
      IDS.residentUser,
      IDS.apartment1,
      IDS.operatorUser,
      IDS.apartment2,
      IDS_EXTRA.apartment3,
    ]
  );

  const result = await adminRoutes.getSystemDeviceHealthSummary();

  assert.deepEqual(result.totals, {
    total_devices: '4',
    healthy_devices: '1',
    degraded_devices: '1',
    unhealthy_devices: '2',
    critical_apartments: '1',
  });
  assert.deepEqual(result.by_building, [
    {
      building_id: IDS.building1,
      building_name: 'Admin Building',
      apartments: '1',
      critical_apartments: '0',
      total_devices: '2',
      healthy_devices: '1',
      degraded_devices: '0',
      unhealthy_devices: '1',
    },
    {
      building_id: IDS.building2,
      building_name: 'Second Building',
      apartments: '2',
      critical_apartments: '1',
      total_devices: '2',
      healthy_devices: '0',
      degraded_devices: '1',
      unhealthy_devices: '1',
    },
  ]);
});

test('PostgreSQL-backed admin user lifecycle plus listing and removal routes persist through the real schema', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedAdminFixture();
  const adminRoutes = loadAdminRoutes();

  const createdResident = await adminRoutes.createUser({
    email: 'resident.two@example.com',
    name: 'Resident Two',
    role: 'resident',
    authentication_method: 'google',
  });
  const createdAdmin = await adminRoutes.createUser({
    email: 'admin.two@example.com',
    name: 'Admin Two',
    role: 'admin',
  });

  const invalidUser = await adminRoutes.createUser({
    email: 'bad@example.com',
    name: 'Bad Role',
    role: 'guest',
  });

  await harness.query(
    `UPDATE users SET id = $1 WHERE id = $2`,
    [IDS_EXTRA.resident2, createdResident.id]
  );
  await harness.query(
    `UPDATE users SET id = $1 WHERE id = $2`,
    [IDS_EXTRA.admin2, createdAdmin.id]
  );

  await harness.query(
    `INSERT INTO users (id, email, name, role)
     VALUES ($1, 'manager2@example.com', 'Manager Two', 'manager')`,
    [IDS_EXTRA.manager2]
  );

  const updatedUser = await adminRoutes.updateUser(IDS_EXTRA.admin2, {
    name: 'Admin Two Updated',
    sleep_mode: true,
  });

  const createdDevice = await adminRoutes.createDevice({
    building_id: IDS.building1,
    name: 'Lobby Intercom',
    gate_id: 'gate-1',
    door_code: '2468',
  });
  await harness.query(
    `INSERT INTO intercoms (id, building_id, name, gate_id, provisioning_code, provisioning_status)
     VALUES ($1, $2, 'Rear Intercom', 'gate-2', '654321', 'active')`,
    [IDS_EXTRA.intercom3, IDS.building2]
  );

  await adminRoutes.assignManager(IDS.building1, { user_id: IDS.operatorUser });
  await adminRoutes.assignManager(IDS.building1, { user_id: IDS_EXTRA.manager2 });
  await adminRoutes.assignResident(IDS.apartment1, { user_id: IDS.residentUser });
  await adminRoutes.assignResident(IDS.apartment1, { user_id: IDS_EXTRA.resident2 });

  const buildings = await adminRoutes.listBuildings();
  const apartments = await adminRoutes.listApartments(IDS.building1);
  const users = await adminRoutes.listUsers();
  const managers = await adminRoutes.listBuildingManagers(IDS.building1);
  const residents = await adminRoutes.listApartmentResidents(IDS.apartment1);
  const devices = await adminRoutes.listDevices();
  const settings = await adminRoutes.listSettings();

  const removedManager = await adminRoutes.removeManager(IDS.building1, IDS_EXTRA.manager2);
  const removedResident = await adminRoutes.removeResident(IDS.apartment1, IDS_EXTRA.resident2);
  const deletedDevice = await adminRoutes.deleteDevice(createdDevice.id);
  const deletedUser = await adminRoutes.deleteUser(IDS_EXTRA.admin2);

  const missingManagerRemoval = await adminRoutes.removeManager(IDS.building1, IDS_EXTRA.manager2);
  const missingResidentRemoval = await adminRoutes.removeResident(IDS.apartment1, IDS_EXTRA.resident2);

  assert.deepEqual(invalidUser, {
    error: 'Invalid role',
    status: 400,
  });
  assert.equal(updatedUser.name, 'Admin Two Updated');
  assert.equal(updatedUser.sleep_mode, true);

  assert.deepEqual(
    buildings.map((row) => ({ id: row.id, name: row.name })),
    [
      { id: IDS.building1, name: 'Admin Building' },
      { id: IDS.building2, name: 'Second Building' },
    ]
  );
  assert.deepEqual(apartments, [
    {
      id: IDS.apartment1,
      building_id: IDS.building1,
      number: '12A',
      name: 'Unit 12A',
      created_at: apartments[0].created_at,
      updated_at: apartments[0].updated_at,
      building_name: 'Admin Building',
      resident_count: 2,
    },
  ]);
  assert.deepEqual(
    users.map((row) => ({ email: row.email, role: row.role, name: row.name })),
    [
      { email: 'admin.two@example.com', role: 'admin', name: 'Admin Two Updated' },
      { email: 'manager@example.com', role: 'manager', name: 'Manager One' },
      { email: 'manager2@example.com', role: 'manager', name: 'Manager Two' },
      { email: 'resident.two@example.com', role: 'resident', name: 'Resident Two' },
      { email: 'resident@example.com', role: 'resident', name: 'Resident One' },
    ]
  );
  assert.deepEqual(
    managers.map((row) => ({ id: row.id, email: row.email, name: row.name })),
    [
      { id: IDS.operatorUser, email: 'manager@example.com', name: 'Manager One' },
      { id: IDS_EXTRA.manager2, email: 'manager2@example.com', name: 'Manager Two' },
    ]
  );
  assert.deepEqual(
    residents.map((row) => ({ id: row.id, email: row.email, name: row.name })),
    [
      { id: IDS.residentUser, email: 'resident@example.com', name: 'Resident One' },
      { id: IDS_EXTRA.resident2, email: 'resident.two@example.com', name: 'Resident Two' },
    ]
  );
  assert.deepEqual(
    devices.map((row) => ({ id: row.id, building_name: row.building_name, provisioning_status: row.provisioning_status, door_code: row.door_code })),
    [
      {
        id: createdDevice.id,
        building_name: 'Admin Building',
        provisioning_status: 'pending',
        door_code: null,
      },
      {
        id: IDS_EXTRA.intercom3,
        building_name: 'Second Building',
        provisioning_status: 'active',
        door_code: null,
      },
    ]
  );
  assert.deepEqual(
    settings.map((row) => row.key),
    ['call_polling_interval', 'intercom_polling_interval', 'max_call_duration', 'no_answer_timeout']
  );
  assert.deepEqual(removedManager, { success: true });
  assert.deepEqual(removedResident, { success: true });
  assert.deepEqual(deletedDevice, { success: true });
  assert.deepEqual(deletedUser, { success: true });
  assert.deepEqual(missingManagerRemoval, {
    error: 'Assignment not found',
    status: 404,
  });
  assert.deepEqual(missingResidentRemoval, {
    error: 'Assignment not found',
    status: 404,
  });

  const managerRows = await harness.query(
    `SELECT building_id, user_id FROM building_managers WHERE building_id = $1 ORDER BY user_id`,
    [IDS.building1]
  );
  const residentRows = await harness.query(
    `SELECT apartment_id, user_id FROM apartment_residents WHERE apartment_id = $1 ORDER BY user_id`,
    [IDS.apartment1]
  );
  const deviceRows = await harness.query(
    `SELECT id FROM intercoms WHERE id = $1`,
    [createdDevice.id]
  );
  const userRows = await harness.query(
    `SELECT id FROM users WHERE id = $1`,
    [IDS_EXTRA.admin2]
  );

  assert.deepEqual(managerRows.rows, [
    {
      building_id: IDS.building1,
      user_id: IDS.operatorUser,
    },
  ]);
  assert.deepEqual(residentRows.rows, [
    {
      apartment_id: IDS.apartment1,
      user_id: IDS.residentUser,
    },
  ]);
  assert.deepEqual(deviceRows.rows, []);
  assert.deepEqual(userRows.rows, []);
});