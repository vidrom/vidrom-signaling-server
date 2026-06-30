const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { GenericContainer, Wait, getContainerRuntimeClient } = require('testcontainers');

const SQL_DIR = path.join(__dirname, '..', '..', 'sql');

async function canRunPostgresIntegration() {
  try {
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

async function loadSqlFiles() {
  const fileNames = (await fs.readdir(SQL_DIR))
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();

  const sql = [];
  for (const fileName of fileNames) {
    const fullPath = path.join(SQL_DIR, fileName);
    sql.push(await fs.readFile(fullPath, 'utf8'));
  }
  return sql.join('\n\n');
}

async function startPostgresHarness() {
  const container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_DB: 'vidrom_test',
      POSTGRES_USER: 'vidrom',
      POSTGRES_PASSWORD: 'vidrom',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
    .start();

  const pool = new Pool({
    host: container.getHost(),
    port: container.getMappedPort(5432),
    database: 'vidrom_test',
    user: 'vidrom',
    password: 'vidrom',
    ssl: false,
  });

  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query(await loadSqlFiles());

  return {
    container,
    pool,
    async query(text, params) {
      return pool.query(text, params);
    },
    async close() {
      await pool.end();
      await container.stop();
    },
  };
}

module.exports = {
  canRunPostgresIntegration,
  startPostgresHarness,
};