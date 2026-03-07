const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'vidrom',
  user: process.env.DB_USER || 'vidrom',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false,
  max: 10,                    // max connections in pool
  idleTimeoutMillis: 30000,   // close idle connections after 30s
  connectionTimeoutMillis: 5000,
});

// Log connection status on startup
pool.on('connect', () => {
  console.log('[DB] New client connected to PostgreSQL');
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// Helper: run a single query
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 200) {
    console.log(`[DB] Slow query (${duration}ms): ${text.substring(0, 80)}`);
  }
  return result;
}

// Helper: get a client for transactions
async function getClient() {
  return pool.connect();
}

// Test the connection (called on server start)
async function testConnection() {
  try {
    const res = await pool.query('SELECT NOW() AS now');
    console.log(`[DB] Connected to PostgreSQL at ${process.env.DB_HOST || 'localhost'} — server time: ${res.rows[0].now}`);
    return true;
  } catch (err) {
    console.error('[DB] Failed to connect to PostgreSQL:', err.message);
    return false;
  }
}

module.exports = { pool, query, getClient, testConnection };
