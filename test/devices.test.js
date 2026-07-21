const test = require('node:test');
const assert = require('node:assert/strict');

const { requireWithMocks } = require('./wsTestHarness');

test('validateProvisioningCode uses updated_at TTL so old devices can be reprovisioned', async () => {
  let captured = null;

  const devices = requireWithMocks('../src/devices', {
    './db': {
      async query(sql, params = []) {
        captured = { sql, params };
        return {
          rows: [
            {
              deviceId: 'intercom-1',
              buildingId: 'building-1',
              name: 'Lobby Intercom',
              status: 'active',
            },
          ],
        };
      },
    },
  });

  const result = await devices.validateProvisioningCode('123456');

  assert.ok(captured, 'query should be executed');
  assert.match(captured.sql, /updated_at >= NOW\(\) - \(\$2::text \|\| ' hours'\)::interval/);
  assert.equal(captured.params[0], '123456');
  assert.equal(result.deviceId, 'intercom-1');
});

test('validateProvisioningCode rejects malformed codes before querying', async () => {
  let queryCalled = false;

  const devices = requireWithMocks('../src/devices', {
    './db': {
      async query() {
        queryCalled = true;
        return { rows: [] };
      },
    },
  });

  const result = await devices.validateProvisioningCode('12 3456');

  assert.equal(result, null);
  assert.equal(queryCalled, false);
});