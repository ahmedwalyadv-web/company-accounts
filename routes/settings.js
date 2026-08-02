const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requirePermission('settings'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 } // 2MB
});

router.get('/', asyncHandler(async (req, res) => {
  const company = await pool.query('SELECT * FROM company_settings WHERE id = 1');
  const reasons = await pool.query('SELECT * FROM expense_reasons ORDER BY name');
  res.render('settings', { title: 'إعدادات الشركة', companyRow: company.rows[0], reasons: reasons.rows, success: null });
}));

router.post('/', upload.single('logo'), asyncHandler(async (req, res) => {
  const { name, currency, anthropic_api_key } = req.body;
  // لو حقل المفتاح فاضي، سيبه كما هو (عشان مانمسحش المفتاح المحفوظ بالغلط)
  // لو المستخدم كتب "-" يبقى قصده يمسح المفتاح
  if (req.file) {
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    if (anthropic_api_key !== undefined && anthropic_api_key !== '') {
      const keyValue = anthropic_api_key === '-' ? null : anthropic_api_key;
      await pool.query(
        'UPDATE company_settings SET name = $1, currency = $2, logo_data = $3, anthropic_api_key = $4, updated_at = NOW() WHERE id = 1',
        [name, currency, base64, keyValue]
      );
    } else {
      await pool.query(
        'UPDATE company_settings SET name = $1, currency = $2, logo_data = $3, updated_at = NOW() WHERE id = 1',
        [name, currency, base64]
      );
    }
  } else if (anthropic_api_key !== undefined && anthropic_api_key !== '') {
    const keyValue = anthropic_api_key === '-' ? null : anthropic_api_key;
    await pool.query(
      'UPDATE company_settings SET name = $1, currency = $2, anthropic_api_key = $3, updated_at = NOW() WHERE id = 1',
      [name, currency, keyValue]
    );
  } else {
    await pool.query(
      'UPDATE company_settings SET name = $1, currency = $2, updated_at = NOW() WHERE id = 1',
      [name, currency]
    );
  }
  res.redirect('/settings');
}));

router.post('/reasons', asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (name && name.trim()) {
    await pool.query('INSERT INTO expense_reasons (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name.trim()]);
  }
  res.redirect('/settings');
}));

router.post('/reasons/:id/toggle', asyncHandler(async (req, res) => {
  await pool.query('UPDATE expense_reasons SET active = NOT active WHERE id = $1', [req.params.id]);
  res.redirect('/settings');
}));

router.post('/reasons/:id/delete', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM expense_reasons WHERE id = $1', [req.params.id]);
  res.redirect('/settings');
}));

module.exports = router;
