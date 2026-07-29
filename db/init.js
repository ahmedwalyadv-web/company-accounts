require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./pool');
const { MODULES } = require('../config/permissions');

const ALL_KEYS = MODULES.map(m => m.key);

async function run() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('⏳ بيتم إنشاء الجداول...');
  await pool.query(schema);

  // إعدادات الشركة (صف واحد)
  await pool.query(`
    INSERT INTO company_settings (id, name, currency)
    VALUES (1, 'اسم شركتك', 'ج.م')
    ON CONFLICT (id) DO NOTHING
  `);

  // الأدوار الافتراضية
  const roles = [
    { name: 'مدير النظام', is_admin: true, permissions: ALL_KEYS },
    { name: 'محاسب', is_admin: false, permissions: ['dashboard','purchases','expenses','sales','receipts','accounts','treasury','reports'] },
    { name: 'مبيعات', is_admin: false, permissions: ['dashboard','sales','receipts','reports'] },
    { name: 'مسؤول مصروفات', is_admin: false, permissions: ['dashboard','purchases','expenses','reports'] }
  ];

  for (const r of roles) {
    await pool.query(
      `INSERT INTO roles (name, is_admin, permissions) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO UPDATE SET is_admin = EXCLUDED.is_admin`,
      [r.name, r.is_admin, r.permissions]
    );
  }

  // مستخدم الأدمن الافتراضي
  const adminRole = await pool.query(`SELECT id FROM roles WHERE name = 'مدير النظام'`);
  const roleId = adminRole.rows[0].id;

  const existingAdmin = await pool.query(`SELECT id FROM users WHERE username = 'admin'`);
  if (existingAdmin.rows.length === 0) {
    const defaultPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(defaultPassword, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role_id, active) VALUES ($1,$2,$3,$4,true)`,
      ['admin', hash, 'مدير النظام', roleId]
    );
    console.log(`✅ تم إنشاء يوزر أدمن: admin / ${defaultPassword} — غيّر الباسورد بعد أول تسجيل دخول`);
  } else {
    console.log('ℹ️ يوزر الأدمن موجود بالفعل');
  }

  // أسباب صرف افتراضية
  const reasons = ['مرتبات', 'مصروفات تشغيل', 'إيجار', 'صيانة', 'مواصلات', 'أخرى'];
  for (const r of reasons) {
    await pool.query(`INSERT INTO expense_reasons (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [r]);
  }

  // شجرة حسابات افتراضية
  const rootAccounts = [
    { name: 'الأصول', type: 'asset' },
    { name: 'الخصوم', type: 'liability' },
    { name: 'حقوق الملكية', type: 'equity' },
    { name: 'الإيرادات', type: 'revenue' },
    { name: 'المصروفات', type: 'expense' }
  ];
  for (const acc of rootAccounts) {
    const exists = await pool.query(`SELECT id FROM accounts WHERE name = $1 AND parent_id IS NULL`, [acc.name]);
    if (exists.rows.length === 0) {
      await pool.query(`INSERT INTO accounts (name, type) VALUES ($1,$2)`, [acc.name, acc.type]);
    }
  }
  // حساب الخزينة تحت الأصول
  const assetsRoot = await pool.query(`SELECT id FROM accounts WHERE name = 'الأصول' AND parent_id IS NULL`);
  if (assetsRoot.rows.length) {
    const treasuryExists = await pool.query(`SELECT id FROM accounts WHERE name = 'الخزينة'`);
    if (treasuryExists.rows.length === 0) {
      await pool.query(`INSERT INTO accounts (name, type, parent_id) VALUES ('الخزينة','asset',$1)`, [assetsRoot.rows[0].id]);
    }
  }

  console.log('✅ تمت تهيئة قاعدة البيانات بنجاح');
  await pool.end();
}

run().catch(err => {
  console.error('❌ حصل خطأ أثناء التهيئة:', err);
  process.exit(1);
});
