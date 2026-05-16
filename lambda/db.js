// Database connection pool — optimized for AWS Lambda
// Lambda instances are reused across invocations (warm starts),
// so a module-level pool persists between requests.
const { GetSecretValueCommand, SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
const { Pool } = require('pg');

const secretsClient = new SecretsManagerClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
});

let poolPromise = null;

async function loadDbConfig() {
  if (!process.env.DB_SECRET_ARN) {
    return {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'vidrom',
      user: process.env.DB_USER || 'vidrom',
      password: process.env.DB_PASSWORD || '',
    };
  }

  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN })
  );
  const secret = JSON.parse(response.SecretString || '{}');

  return {
    host: secret.host,
    port: parseInt(secret.port || '5432', 10),
    database: secret.dbname || secret.dbName || process.env.DB_NAME || 'vidrom',
    user: secret.username || secret.user,
    password: secret.password || '',
  };
}

async function getPool() {
  if (!poolPromise) {
    poolPromise = loadDbConfig().then((config) => {
      const pool = new Pool({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ssl: config.host ? { rejectUnauthorized: false } : false,
        max: 1,
        idleTimeoutMillis: 120000,
        connectionTimeoutMillis: 5000,
      });

      pool.on('error', (err) => {
        console.error('[DB] Unexpected pool error:', err.message);
      });

      return pool;
    });
  }

  return poolPromise;
}

async function query(text, params) {
  const pool = await getPool();
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 200) {
    console.log(`[DB] Slow query (${duration}ms): ${text.substring(0, 80)}`);
  }
  return result;
}

async function getClient() {
  const pool = await getPool();
  return pool.connect();
}

module.exports = { query, getClient, getPool };
