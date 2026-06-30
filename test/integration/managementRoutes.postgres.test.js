const test = require('node:test');
const assert = require('node:assert/strict');

const { requireWithMocks } = require('../wsTestHarness');
const { canRunPostgresIntegration, startPostgresHarness } = require('./postgresHarness');
const { IDS, resetCoreTables } = require('./postgresFixtures');

const IDS_EXTRA = {
  intercom2: '77777777-7777-7777-7777-777777777778',
  apartment3: '44444444-4444-4444-4444-444444444445',
  call2: '88888888-8888-8888-8888-888888888889',
  call3: '88888888-8888-8888-8888-888888888890',
};

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

function loadManagementRoutes() {
  return requireWithMocks('../../lambda/managementRoutes', {
    './db': {
      query: harness.query.bind(harness),
    },
  });
}

async function seedManagementScopeFixture() {
  await resetCoreTables(harness);

  await harness.query(
    `INSERT INTO buildings (id, name, address, volume)
     VALUES ($1, 'Managed Building', '1 Main St', 50),
            ($2, 'Other Building', '2 Main St', 60)`,
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
            ($2, 'resident1@example.com', 'Resident One', 'resident'),
            ($3, 'resident2@example.com', 'Resident Two', 'resident')`,
    [IDS.operatorUser, IDS.residentUser, IDS.residentUser2]
  );
  await harness.query(
    `INSERT INTO building_managers (building_id, user_id)
     VALUES ($1, $2)`,
    [IDS.building1, IDS.operatorUser]
  );
  await harness.query(
    `INSERT INTO intercoms (id, building_id, name, gate_id, status, provisioning_code, provisioning_status)
     VALUES ($1, $2, 'Managed Intercom', 'gate-1', 'connected', '111111', 'active'),
            ($3, $4, 'Other Intercom', 'gate-2', 'connected', '222222', 'active')`,
    [IDS.intercom1, IDS.building1, IDS_EXTRA.intercom2, IDS.building2]
  );
  await harness.query(
    `INSERT INTO notifications (id, building_id, text)
     VALUES ('99999999-9999-9999-9999-999999999991', $1, 'Managed notice'),
            ('99999999-9999-9999-9999-999999999992', $2, 'Other notice')`,
    [IDS.building1, IDS.building2]
  );
  await harness.query(
    `INSERT INTO audit_logs (id, event_type, building_id, apartment_id, user_id, intercom_id, description)
     VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'door-open', $1, $3, $5, $7, 'Managed audit'),
            ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', 'door-open', $2, $4, $6, $8, 'Other audit')`,
    [IDS.building1, IDS.building2, IDS.apartment1, IDS.apartment2, IDS.residentUser, IDS.residentUser2, IDS.intercom1, IDS_EXTRA.intercom2]
  );
}

test('PostgreSQL-backed management routes forbid building updates outside the assigned scope', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedManagementScopeFixture();
  const managementRoutes = loadManagementRoutes();

  const forbidden = await managementRoutes.updateBuilding([IDS.building1], IDS.building2, { volume: 77 });

  assert.deepEqual(forbidden, {
    error: 'Forbidden — building not assigned to you',
    status: 403,
  });

  const buildingRows = await harness.query(
    `SELECT id, volume FROM buildings WHERE id = $1`,
    [IDS.building2]
  );
  assert.deepEqual(buildingRows.rows, [{ id: IDS.building2, volume: 60 }]);
});

test('PostgreSQL-backed management apartment creation and resident assignment persist within the assigned building', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedManagementScopeFixture();
  const managementRoutes = loadManagementRoutes();

  const apartment = await managementRoutes.createApartment([IDS.building1], IDS.building1, {
    number: '15C',
    name: 'Unit 15C',
  });

  assert.equal(apartment.building_id, IDS.building1);
  assert.equal(apartment.number, '15C');
  assert.equal(apartment.name, 'Unit 15C');

  const assignResult = await managementRoutes.assignResident([IDS.building1], apartment.id, {
    user_id: IDS.residentUser,
  });
  assert.deepEqual(assignResult, { success: true });

  const forbidden = await managementRoutes.assignResident([IDS.building1], IDS.apartment2, {
    user_id: IDS.residentUser2,
  });
  assert.deepEqual(forbidden, {
    error: 'Forbidden — building not assigned to you',
    status: 403,
  });

  const residentRows = await harness.query(
    `SELECT apartment_id, user_id
     FROM apartment_residents
     WHERE apartment_id = $1`,
    [apartment.id]
  );
  assert.deepEqual(residentRows.rows, [
    {
      apartment_id: apartment.id,
      user_id: IDS.residentUser,
    },
  ]);
});

test('PostgreSQL-backed management device reprovision and revoke mutate only assigned devices', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedManagementScopeFixture();
  const managementRoutes = loadManagementRoutes();

  const reprovisioned = await managementRoutes.reprovisionDevice([IDS.building1], IDS.intercom1);
  assert.equal(reprovisioned.id, IDS.intercom1);
  assert.equal(reprovisioned.provisioning_status, 'pending');
  assert.match(reprovisioned.provisioning_code, /^\d{6}$/);

  const revokeResult = await managementRoutes.revokeDevice([IDS.building1], IDS.intercom1);
  assert.deepEqual(revokeResult, { success: true });

  const forbidden = await managementRoutes.reprovisionDevice([IDS.building1], IDS_EXTRA.intercom2);
  assert.deepEqual(forbidden, {
    error: 'Forbidden — building not assigned to you',
    status: 403,
  });

  const intercomRows = await harness.query(
    `SELECT id, status, provisioning_status, provisioning_code
     FROM intercoms
     WHERE id IN ($1, $2)
     ORDER BY id ASC`,
    [IDS.intercom1, IDS_EXTRA.intercom2]
  );
  assert.deepEqual(intercomRows.rows, [
    {
      id: IDS.intercom1,
      status: 'disconnected',
      provisioning_status: 'pending',
      provisioning_code: reprovisioned.provisioning_code,
    },
    {
      id: IDS_EXTRA.intercom2,
      status: 'connected',
      provisioning_status: 'active',
      provisioning_code: '222222',
    },
  ]);
});

test('PostgreSQL-backed management audit and notification listings only return assigned building rows', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedManagementScopeFixture();
  const managementRoutes = loadManagementRoutes();

  const auditRows = await managementRoutes.listAuditLogs([IDS.building1], {});
  const notificationRows = await managementRoutes.listNotifications([IDS.building1]);

  assert.deepEqual(auditRows.map((row) => ({ building_id: row.building_id, description: row.description })), [
    {
      building_id: IDS.building1,
      description: 'Managed audit',
    },
  ]);
  assert.deepEqual(notificationRows.map((row) => ({ building_id: row.building_id, text: row.text })), [
    {
      building_id: IDS.building1,
      text: 'Managed notice',
    },
  ]);
});

test('PostgreSQL-backed management scoped listings and mutations persist only within assigned buildings', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedManagementScopeFixture();
  const managementRoutes = loadManagementRoutes();

  await harness.query(
    `INSERT INTO apartment_residents (apartment_id, user_id)
     VALUES ($1, $2),
            ($3, $4)`,
    [IDS.apartment1, IDS.residentUser, IDS.apartment2, IDS.residentUser2]
  );

  const buildings = await managementRoutes.listBuildings([IDS.building1]);
  const apartments = await managementRoutes.listApartments([IDS.building1], IDS.building1);
  const residents = await managementRoutes.listResidents([IDS.building1], IDS.apartment1);

  const createdNotification = await managementRoutes.createNotification([IDS.building1], {
    building_id: IDS.building1,
    text: 'Managed follow-up notice',
  });
  const createdDevice = await managementRoutes.createDevice([IDS.building1], {
    building_id: IDS.building1,
    name: 'Side Door Intercom',
    gate_id: 'gate-3',
  });
  const updatedApartment = await managementRoutes.updateApartment([IDS.building1], IDS.apartment1, {
    number: '12B',
    name: 'Unit 12B',
  });
  const removeResidentResult = await managementRoutes.removeResident([IDS.building1], IDS.apartment1, IDS.residentUser);
  const deleteNotificationResult = await managementRoutes.deleteNotification([IDS.building1], createdNotification.id);
  const deleteApartmentResult = await managementRoutes.deleteApartment([IDS.building1], IDS.apartment1);

  const forbiddenApartmentUpdate = await managementRoutes.updateApartment([IDS.building1], IDS.apartment2, {
    name: 'Should fail',
  });
  const forbiddenNotificationCreate = await managementRoutes.createNotification([IDS.building1], {
    building_id: IDS.building2,
    text: 'Forbidden notice',
  });

  assert.deepEqual(buildings.map((row) => ({ id: row.id, name: row.name })), [
    {
      id: IDS.building1,
      name: 'Managed Building',
    },
  ]);
  assert.deepEqual(apartments.map((row) => ({ id: row.id, building_name: row.building_name, number: row.number, resident_count: row.resident_count })), [
    {
      id: IDS.apartment1,
      building_name: 'Managed Building',
      number: '12A',
      resident_count: 1,
    },
  ]);
  assert.deepEqual(residents.map((row) => ({ id: row.id, email: row.email, name: row.name })), [
    {
      id: IDS.residentUser,
      email: 'resident1@example.com',
      name: 'Resident One',
    },
  ]);
  assert.equal(createdDevice.building_id, IDS.building1);
  assert.equal(createdDevice.name, 'Side Door Intercom');
  assert.equal(createdDevice.gate_id, 'gate-3');
  assert.equal(createdDevice.provisioning_status, 'pending');
  assert.match(createdDevice.provisioning_code, /^\d{6}$/);
  assert.deepEqual(updatedApartment, {
    id: IDS.apartment1,
    building_id: IDS.building1,
    number: '12B',
    name: 'Unit 12B',
    created_at: updatedApartment.created_at,
    updated_at: updatedApartment.updated_at,
  });
  assert.deepEqual(removeResidentResult, { success: true });
  assert.deepEqual(deleteNotificationResult, { success: true });
  assert.deepEqual(deleteApartmentResult, { success: true });
  assert.deepEqual(forbiddenApartmentUpdate, {
    error: 'Forbidden — building not assigned to you',
    status: 403,
  });
  assert.deepEqual(forbiddenNotificationCreate, {
    error: 'Forbidden — building not assigned to you',
    status: 403,
  });

  const deviceRows = await harness.query(
    `SELECT id, building_id, name, gate_id, provisioning_code, provisioning_status
     FROM intercoms
     WHERE id = $1`,
    [createdDevice.id]
  );
  const residentRows = await harness.query(
    `SELECT apartment_id, user_id
     FROM apartment_residents
     WHERE apartment_id = $1`,
    [IDS.apartment1]
  );
  const notificationRows = await harness.query(
    `SELECT id
     FROM notifications
     WHERE id = $1`,
    [createdNotification.id]
  );
  const apartmentRows = await harness.query(
    `SELECT id
     FROM apartments
     WHERE id = $1`,
    [IDS.apartment1]
  );
  const listedDevices = await managementRoutes.listDevices([IDS.building1]);

  assert.deepEqual(deviceRows.rows, [
    {
      id: createdDevice.id,
      building_id: IDS.building1,
      name: 'Side Door Intercom',
      gate_id: 'gate-3',
      provisioning_code: createdDevice.provisioning_code,
      provisioning_status: 'pending',
    },
  ]);
  assert.deepEqual(residentRows.rows, []);
  assert.deepEqual(notificationRows.rows, []);
  assert.deepEqual(apartmentRows.rows, []);
  assert.deepEqual(
    listedDevices.map((row) => ({ id: row.id, building_id: row.building_id, building_name: row.building_name })).sort((a, b) => a.id.localeCompare(b.id)),
    [
      {
        id: IDS.intercom1,
        building_id: IDS.building1,
        building_name: 'Managed Building',
      },
      {
        id: createdDevice.id,
        building_id: IDS.building1,
        building_name: 'Managed Building',
      },
    ].sort((a, b) => a.id.localeCompare(b.id))
  );
});

test('PostgreSQL-backed management delivery health only aggregates assigned-building rows', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedManagementScopeFixture();
  const managementRoutes = loadManagementRoutes();

  await harness.query(
    `INSERT INTO apartments (id, building_id, number, name)
     VALUES ($1, $2, '13C', 'Unit 13C')`,
    [IDS_EXTRA.apartment3, IDS.building1]
  );
  await harness.query(
    `INSERT INTO apartment_residents (apartment_id, user_id)
     VALUES ($1, $2),
            ($3, $4)`,
    [IDS.apartment1, IDS.residentUser, IDS.apartment2, IDS.residentUser2]
  );
  await harness.query(
    `INSERT INTO device_tokens (apartment_id, user_id, token, token_type, platform, created_at, updated_at)
     VALUES
       ($1, $2, 'managed-fcm', 'fcm', 'ios', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 hour'),
       ($1, $2, 'managed-voip', 'voip', 'ios', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 hour'),
       ($3, $4, 'other-fcm', 'fcm', 'android', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 hour')`,
    [IDS.apartment1, IDS.residentUser, IDS.apartment2, IDS.residentUser2]
  );
  await harness.query(
    `INSERT INTO calls (id, building_id, apartment_id, intercom_id, status, created_at, ended_at)
     VALUES
       ($1, $2, $3, $4, 'accepted', NOW() - INTERVAL '1 day', NOW() - INTERVAL '23 hours 55 minutes'),
       ($5, $2, $3, $4, 'unanswered', NOW() - INTERVAL '2 days', NOW() - INTERVAL '47 hours 59 minutes'),
       ($6, $7, $8, $9, 'accepted', NOW() - INTERVAL '3 days', NOW() - INTERVAL '71 hours 58 minutes')`,
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
    `INSERT INTO call_delivery_attempts (
       call_id, user_id, device_token, token_type, platform, attempt_number, delivery_state, last_error, last_attempt_at, acked_at
     ) VALUES
       ($1, $2, 'managed-fcm', 'fcm', 'ios', 1, 'push-sent', NULL, NOW() - INTERVAL '1 day', NULL),
       ($1, $2, 'managed-fcm', 'fcm', 'ios', 2, 'push-received', NULL, NOW() - INTERVAL '23 hours 59 minutes', NOW() - INTERVAL '23 hours 59 minutes'),
       ($1, $2, 'managed-voip', 'voip', 'ios', 1, 'push-failed', 'APNS_UNREGISTERED', NOW() - INTERVAL '23 hours 58 minutes', NULL),
       ($3, $2, 'managed-fcm', 'fcm', 'ios', 1, 'timed-out', NULL, NOW() - INTERVAL '2 days', NULL),
       ($4, $5, 'other-fcm', 'fcm', 'android', 1, 'push-sent', NULL, NOW() - INTERVAL '3 days', NULL),
       ($4, $5, 'other-fcm', 'fcm', 'android', 2, 'push-received', NULL, NOW() - INTERVAL '71 hours 57 minutes', NOW() - INTERVAL '71 hours 57 minutes')`,
    [
      IDS.call1,
      IDS.residentUser,
      IDS_EXTRA.call2,
      IDS_EXTRA.call3,
      IDS.residentUser2,
    ]
  );
  await harness.query(
    `INSERT INTO call_delivery_acks (call_id, user_id, device_token, token_type, platform, event, created_at)
     VALUES
       ($1, $2, 'managed-fcm', 'fcm', 'ios', 'push-received', NOW() - INTERVAL '23 hours 59 minutes'),
       ($3, $4, 'other-fcm', 'fcm', 'android', 'push-received', NOW() - INTERVAL '71 hours 57 minutes')`,
    [IDS.call1, IDS.residentUser, IDS_EXTRA.call3, IDS.residentUser2]
  );

  const result = await managementRoutes.getDeliveryHealth([IDS.building1], {});

  assert.deepEqual(
    result.recent_calls.map((row) => ({
      call_id: row.call_id,
      building_id: row.building_id,
      building_name: row.building_name,
      apartment_number: row.apartment_number,
      devices_targeted: row.devices_targeted,
      devices_acked: row.devices_acked,
      devices_failed: row.devices_failed,
      devices_timed_out: row.devices_timed_out,
      max_retries: row.max_retries,
    })),
    [
      {
        call_id: IDS.call1,
        building_id: IDS.building1,
        building_name: 'Managed Building',
        apartment_number: '12A',
        devices_targeted: '2',
        devices_acked: '1',
        devices_failed: '1',
        devices_timed_out: '0',
        max_retries: 2,
      },
      {
        call_id: IDS_EXTRA.call2,
        building_id: IDS.building1,
        building_name: 'Managed Building',
        apartment_number: '12A',
        devices_targeted: '1',
        devices_acked: '0',
        devices_failed: '0',
        devices_timed_out: '1',
        max_retries: 1,
      },
    ]
  );
  assert.equal(result.delivery_rate, 50);
  assert.equal(result.total_calls_7d, 2);
  assert.equal(result.calls_with_ack_7d, 1);
  assert.deepEqual(result.avg_latency, [
    {
      platform: 'ios',
      avg_latency_sec: '60.00',
    },
  ]);
  assert.deepEqual(result.failed_deliveries, [
    {
      last_error: 'APNS_UNREGISTERED',
      count: '1',
    },
  ]);
  assert.deepEqual(result.unhealthy_apartments, [
    {
      id: IDS_EXTRA.apartment3,
      number: '13C',
      name: 'Unit 13C',
      building_name: 'Managed Building',
    },
  ]);
});

test('PostgreSQL-backed management device health enforces building scope and returns real apartment-health rows', async (t) => {
  if (!dockerAvailable) {
    t.skip('Docker/container runtime unavailable for PostgreSQL-backed integration test');
    return;
  }

  await seedManagementScopeFixture();
  const managementRoutes = loadManagementRoutes();

  await harness.query(
    `INSERT INTO apartments (id, building_id, number, name)
     VALUES ($1, $2, '13C', 'Unit 13C')`,
    [IDS_EXTRA.apartment3, IDS.building1]
  );
  await harness.query(
    `INSERT INTO device_health (
       device_token, user_id, apartment_id, platform, token_type,
       last_successful_push, last_token_refresh, health_score
     ) VALUES
       ('healthy-managed', $1, $2, 'ios', 'fcm', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', 95),
       ('degraded-managed', $1, $2, 'ios', 'voip', NOW() - INTERVAL '1 day', NOW() - INTERVAL '40 days', 60),
       ('critical-managed', $3, $4, 'android', 'fcm', NOW() - INTERVAL '20 days', NOW() - INTERVAL '40 days', 40),
       ('other-building-healthy', $5, $6, 'android', 'fcm', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', 90)`,
    [
      IDS.residentUser,
      IDS.apartment1,
      IDS.residentUser2,
      IDS_EXTRA.apartment3,
      IDS.operatorUser,
      IDS.apartment2,
    ]
  );

  const scopedRows = await managementRoutes.getDeviceHealth([IDS.building1], IDS.building1);
  const forbidden = await managementRoutes.getDeviceHealth([IDS.building1], IDS.building2);

  assert.deepEqual(scopedRows, [
    {
      apartment_id: IDS.apartment1,
      apartment_number: '12A',
      building_id: IDS.building1,
      total_devices: '2',
      healthy_devices: '1',
      degraded_devices: '1',
      unhealthy_devices: '0',
      apartment_health: 'ok',
    },
    {
      apartment_id: IDS_EXTRA.apartment3,
      apartment_number: '13C',
      building_id: IDS.building1,
      total_devices: '1',
      healthy_devices: '0',
      degraded_devices: '0',
      unhealthy_devices: '1',
      apartment_health: 'critical',
    },
  ]);
  assert.deepEqual(forbidden, {
    error: 'Forbidden — building not assigned to you',
    status: 403,
  });
});