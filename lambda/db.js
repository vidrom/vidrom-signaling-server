// Database connection pool — optimized for AWS Lambda
// Lambda instances are reused across invocations (warm starts),
// so a module-level pool persists between requests.
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'vidrom',
  user: process.env.DB_USER || 'vidrom',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false,
  max: 1,                     // one connection per Lambda instance
  idleTimeoutMillis: 120000,  // keep alive during warm invocations
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 200) {
    console.log(`[DB] Slow query (${duration}ms): ${text.substring(0, 80)}`);
  }
  return result;
}

async function getClient() {
  return pool.connect();
}

module.exports = { pool, query, getClient };
