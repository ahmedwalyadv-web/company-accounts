const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('❌ لازم تحدد DATABASE_URL في ملف .env (راجع ملف DEPLOY.md)');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  max: process.env.PGPOOL_MAX ? parseInt(process.env.PGPOOL_MAX, 10) : 10
});

module.exports = pool;
