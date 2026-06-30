const IDS = {
  building1: '11111111-1111-1111-1111-111111111111',
  building2: '22222222-2222-2222-2222-222222222222',
  apartment1: '33333333-3333-3333-3333-333333333333',
  apartment2: '44444444-4444-4444-4444-444444444444',
  residentUser: '55555555-5555-5555-5555-555555555555',
  residentUser2: '55555555-5555-5555-5555-555555555556',
  operatorUser: '66666666-6666-6666-6666-666666666666',
  intercom1: '77777777-7777-7777-7777-777777777777',
  call1: '88888888-8888-8888-8888-888888888888',
};

async function resetCoreTables(harness) {
  await harness.query('TRUNCATE apartment_residents, building_managers, device_tokens, device_health, call_delivery_acks, call_delivery_attempts, audit_logs, client_errors, calls, intercoms, users, apartments, buildings RESTART IDENTITY CASCADE');
  await harness.query('DELETE FROM global_settings');
  await harness.query(`INSERT INTO global_settings (key, value, description) VALUES
    ('max_call_duration', '60', 'Maximum duration allowed for a call (seconds)'),
    ('no_answer_timeout', '30', 'Default duration before an unanswered call auto-ends (seconds)'),
    ('call_polling_interval', '3', 'How often to poll for call status (seconds)'),
    ('intercom_polling_interval', '2', 'How often to poll intercom status (seconds)')`);
}

async function seedResidentFixture(harness, { firebaseUid = null } = {}) {
  await resetCoreTables(harness);

  await harness.query(
    `INSERT INTO buildings (id, name, address)
     VALUES ($1, 'Vidrom Towers', '1 Main St')`,
    [IDS.building1]
  );
  await harness.query(
    `INSERT INTO apartments (id, building_id, number, name)
     VALUES ($1, $3, '12A', 'Unit 12A'),
            ($2, $3, '14B', 'Unit 14B')`,
    [IDS.apartment1, IDS.apartment2, IDS.building1]
  );
  await harness.query(
    `INSERT INTO users (id, email, name, role, firebase_uid)
     VALUES ($1, 'resident@example.com', 'Resident One', 'resident', $2)`,
    [IDS.residentUser, firebaseUid]
  );
  await harness.query(
    `INSERT INTO apartment_residents (apartment_id, user_id)
     VALUES ($1, $3),
            ($2, $3)`,
    [IDS.apartment1, IDS.apartment2, IDS.residentUser]
  );
}

async function seedOperatorFixture(harness, { role, googleSubject = null, email = 'operator@example.com' }) {
  await resetCoreTables(harness);

  await harness.query(
    `INSERT INTO buildings (id, name, address)
     VALUES ($1, 'Vidrom Towers', '1 Main St'),
            ($2, 'Vidrom Plaza', '2 Main St')`,
    [IDS.building1, IDS.building2]
  );
  await harness.query(
    `INSERT INTO users (id, email, name, role, google_subject)
     VALUES ($1, $2, 'Operator One', $3, $4)`,
    [IDS.operatorUser, email, role, googleSubject]
  );

  if (role === 'manager') {
    await harness.query(
      `INSERT INTO building_managers (building_id, user_id)
       VALUES ($1, $3),
              ($2, $3)`,
      [IDS.building1, IDS.building2, IDS.operatorUser]
    );
  }
}

async function seedResidentCallFixture(harness, { firebaseUid = 'firebase-user-1', callStatus = 'calling' } = {}) {
  await seedResidentFixture(harness, { firebaseUid });

  await harness.query(
    `INSERT INTO intercoms (id, building_id, name, provisioning_status)
     VALUES ($1, $2, 'Lobby Intercom', 'active')`,
    [IDS.intercom1, IDS.building1]
  );
  await harness.query(
    `INSERT INTO calls (id, building_id, apartment_id, intercom_id, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [IDS.call1, IDS.building1, IDS.apartment1, IDS.intercom1, callStatus]
  );
}

async function seedResidentRingFixture(harness, { firebaseUid = 'firebase-user-1' } = {}) {
  await seedResidentFixture(harness, { firebaseUid });

  await harness.query(
    `INSERT INTO intercoms (id, building_id, name, provisioning_status)
     VALUES ($1, $2, 'Lobby Intercom', 'active')`,
    [IDS.intercom1, IDS.building1]
  );
}

async function seedSleepModeRingFixture(harness, { allSleeping = false } = {}) {
  await resetCoreTables(harness);

  await harness.query(
    `INSERT INTO buildings (id, name, address)
     VALUES ($1, 'Vidrom Towers', '1 Main St')`,
    [IDS.building1]
  );
  await harness.query(
    `INSERT INTO apartments (id, building_id, number, name)
     VALUES ($1, $2, '12A', 'Unit 12A')`,
    [IDS.apartment1, IDS.building1]
  );
  await harness.query(
    `INSERT INTO users (id, email, name, role, firebase_uid, sleep_mode)
     VALUES ($1, 'resident@example.com', 'Resident One', 'resident', 'firebase-user-1', true),
            ($2, 'resident2@example.com', 'Resident Two', 'resident', 'firebase-user-2', $3)`,
    [IDS.residentUser, IDS.residentUser2, allSleeping]
  );
  await harness.query(
    `INSERT INTO apartment_residents (apartment_id, user_id)
     VALUES ($1, $2),
            ($1, $3)`,
    [IDS.apartment1, IDS.residentUser, IDS.residentUser2]
  );
  await harness.query(
    `INSERT INTO intercoms (id, building_id, name, provisioning_status)
     VALUES ($1, $2, 'Lobby Intercom', 'active')`,
    [IDS.intercom1, IDS.building1]
  );
}

module.exports = {
  IDS,
  resetCoreTables,
  seedResidentFixture,
  seedResidentCallFixture,
  seedResidentRingFixture,
  seedSleepModeRingFixture,
  seedOperatorFixture,
};