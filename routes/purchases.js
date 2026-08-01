const express = require('express');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const { isPeriodClosed } = require('../db/periodLock');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requirePermission('purchases'));

const PAYMENT_METHODS = [
  { value: 'cash', label: 'كاش' },
  { value: 'visa', label: 'فيزا' },
  { value: 'network', label: 'شبكة' }
];
const PAYMENT_LABELS = Object.fromEntries(PAYMENT_METHODS.map(p => [p.value, p.label]));
const VALID_METHODS = PAYMENT_METHODS.map(p => p.value);

router.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT t.*, u.full_name AS created_by_name, p.full_name AS paid_by_name, a.name AS account_name
     FROM purchases t
     LEFT JOIN users u ON t.created_by = u.id
     LEFT JOIN users p ON t.paid_by_user_id = p.id
     LEFT JOIN accounts a ON t.account_id = a.id
     WHERE NOT EXISTS (
       SELECT 1 FROM monthly_closings mc WHERE mc.period = date_trunc('month', t.entry_date)::date
     )
     ORDER BY t.entry_date DESC, t.id DESC LIMIT 300`
  );
  const totalResult = await pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM purchases`);
  res.render('transactions/list', {
    title: 'المشتريات',
    pageTitle: 'المشتريات',
    moduleKey: 'purchases',
    partyLabel: 'المورد',
    paymentLabels: PAYMENT_LABELS,
    rows: result.rows,
    total: totalResult.rows[0].total,
    error: req.query.error === 'closed'
      ? 'الشهر ده مقفول (تم عمل تقفيل شهري ليه)، مينفعش تضيف أو تعدل أو تحذف حركات فيه. لو محتاج تعدل، لازم الأدمن يفتح الشهر تاني من صفحة التقفيل الشهري.'
      : (req.query.error === 'invalid' ? 'البيانات المدخلة ناقصة أو غير صحيحة، برجاء المحاولة تاني.' : null)
  });
}));

router.get('/new', asyncHandler(async (req, res) => {
  const accounts = (await pool.query(`SELECT * FROM accounts ORDER BY name`)).rows;
  const users = (await pool.query(`SELECT id, full_name FROM users WHERE active = true ORDER BY full_name`)).rows;
  res.render('transactions/form', {
    title: 'إضافة حركة — المشتريات',
    pageTitle: 'المشتريات',
    moduleKey: 'purchases',
    partyLabel: 'المورد',
    useReasonDropdown: false,
    reasons: [],
    accounts,
    users,
    paymentMethods: PAYMENT_METHODS,
    row: null,
    today: new Date().toISOString().slice(0, 10)
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { entry_date, party, amount, account_id, description, payment_method, paid_by_user_id } = req.body;

  if (!entry_date || !party || amount === undefined || amount === '' || isNaN(Number(amount))) {
    return res.redirect('/purchases?error=invalid');
  }
  const method = VALID_METHODS.includes(payment_method) ? payment_method : 'cash';
  if (await isPeriodClosed(entry_date)) {
    return res.redirect('/purchases?error=closed');
  }

  const userId = req.session.user.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO purchases (entry_date, party, amount, account_id, description, payment_method, paid_by_user_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [entry_date, party, amount, account_id || null, description || null, method, paid_by_user_id || null, userId]
    );
    await client.query(
      `INSERT INTO treasury_ledger (entry_date, direction, amount, source_module, source_id, description, created_by)
       VALUES ($1,'out',$2,'purchases',$3,$4,$5)`,
      [entry_date, amount, inserted.rows[0].id, `المشتريات — ${party} (${PAYMENT_LABELS[method]})`, userId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.redirect('/purchases');
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const result = await pool.query(`SELECT * FROM purchases WHERE id = $1`, [req.params.id]);
  if (!result.rows.length) return res.redirect('/purchases');
  if (await isPeriodClosed(result.rows[0].entry_date)) {
    return res.redirect('/purchases?error=closed');
  }
  const accounts = (await pool.query(`SELECT * FROM accounts ORDER BY name`)).rows;
  const users = (await pool.query(`SELECT id, full_name FROM users WHERE active = true ORDER BY full_name`)).rows;
  res.render('transactions/form', {
    title: 'تعديل حركة — المشتريات',
    pageTitle: 'المشتريات',
    moduleKey: 'purchases',
    partyLabel: 'المورد',
    useReasonDropdown: false,
    reasons: [],
    accounts,
    users,
    paymentMethods: PAYMENT_METHODS,
    row: result.rows[0],
    today: new Date().toISOString().slice(0, 10)
  });
}));

router.post('/:id', asyncHandler(async (req, res) => {
  const { entry_date, party, amount, account_id, description, payment_method, paid_by_user_id } = req.body;

  if (!entry_date || !party || amount === undefined || amount === '' || isNaN(Number(amount))) {
    return res.redirect('/purchases?error=invalid');
  }
  const method = VALID_METHODS.includes(payment_method) ? payment_method : 'cash';

  const existing = await pool.query(`SELECT entry_date FROM purchases WHERE id = $1`, [req.params.id]);
  if (!existing.rows.length) return res.redirect('/purchases');
  if ((await isPeriodClosed(existing.rows[0].entry_date)) || (await isPeriodClosed(entry_date))) {
    return res.redirect('/purchases?error=closed');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE purchases SET entry_date=$1, party=$2, amount=$3, account_id=$4, description=$5, payment_method=$6, paid_by_user_id=$7 WHERE id=$8`,
      [entry_date, party, amount, account_id || null, description || null, method, paid_by_user_id || null, req.params.id]
    );
    await client.query(
      `UPDATE treasury_ledger SET entry_date=$1, amount=$2, description=$3
       WHERE source_module = 'purchases' AND source_id = $4`,
      [entry_date, amount, `المشتريات — ${party} (${PAYMENT_LABELS[method]})`, req.params.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.redirect('/purchases');
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  const existing = await pool.query(`SELECT entry_date FROM purchases WHERE id = $1`, [req.params.id]);
  if (!existing.rows.length) return res.redirect('/purchases');
  if (await isPeriodClosed(existing.rows[0].entry_date)) {
    return res.redirect('/purchases?error=closed');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM treasury_ledger WHERE source_module = 'purchases' AND source_id = $1`, [req.params.id]);
    await client.query(`DELETE FROM purchases WHERE id = $1`, [req.params.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.redirect('/purchases');
}));

module.exports = router;
