const dns = require('dns');
const { Pool } = require('pg');

// بعض منصات الاستضافة (زي Render) مش بتدعم IPv6 للاتصالات الصادرة،
// وNode ممكن يحاول يتصل بـ IPv6 الأول ويفشل بـ ETIMEDOUT.
// السطر ده بيجبر Node يفضل IPv4 أول حاجة، وده بيحل المشكلة دي مع Supabase.
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {
  // متاح من Node 18 فما فوق، لو النسخة أقدم هنتجاهل الإعداد ده
}

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
