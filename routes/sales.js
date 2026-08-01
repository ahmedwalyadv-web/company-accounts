const express = require('express');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const { isPeriodClosed } = require('../db/periodLock');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requirePermission('sales'));

const PAYMENT_METHODS = [
  { value: 'cash', label: 'كاش' },
  { value: 'bank', label: 'حساب بنكي' }
];
const PAYMENT_LABELS = Object.fromEntries(PAYMENT_METHODS.map(p => [p.value, p.label]));
const VALID_METHODS = PAYMENT_METHODS.map(p => p.value);

router.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT t.*, u.full_name AS created_by_name, r.full_name AS received_by_name, a.name AS account_name
     FROM sales t
     LEFT JOIN users u ON t.created_by = u.id
     LEFT JOIN users r ON t.received_by_user_id = r.id
     LEFT JOIN accounts a ON t.account_id = a.id
     WHERE NOT EXISTS (
       SELECT 1 FROM monthly_closings mc WHERE mc.period = date_trunc('month', t.entry_date)::date
     )
     ORDER BY t.entry_date DESC, t.id DESC LIMIT 300`
  );
  const totalResult = await pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM sales`);
  res.render('transactions/list', {
    title: 'المبيعات',
    pageTitle: 'المبيعات',
    moduleKey: 'sales',
    partyLabel: 'العميل',
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
    title: 'إضافة حركة — المبيعات',
    pageTitle: 'المبيعات',
    moduleKey: 'sales',
    partyLabel: 'العميل',
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
  const { entry_date, party, amount, account_id, description, payment_method, received_by_user_id } = req.body;

  if (!entry_date || !party || amount === undefined || amount === '' || isNaN(Number(amount))) {
    return res.redirect('/sales?error=invalid');
  }
  const method = VALID_METHODS.includes(payment_method) ? payment_method : 'cash';
  // لو الدفع بحساب بنكي، لازم تختار الحساب. لو كاش، لازم تحدد مين استلم
  if (method === 'bank' && !account_id) {
    return res.redirect('/sales?error=invalid');
  }
  if (await isPeriodClosed(entry_date)) {
    return res.redirect('/sales?error=closed');
  }

  const userId = req.session.user.id;
  const finalAccountId = method === 'bank' ? account_id : null;
  const finalReceivedBy = method === 'cash' ? (received_by_user_id || null) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO sales (entry_date, party, amount, account_id, description, payment_method, received_by_user_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [entry_date, party, amount, finalAccountId, description || null, method, finalReceivedBy, userId]
    );
    await client.query(
      `INSERT INTO treasury_ledger (entry_date, direction, amount, source_module, source_id, description, created_by)
       VALUES ($1,'in',$2,'sales',$3,$4,$5)`,
      [entry_date, amount, inserted.rows[0].id, `المبيعات — ${party} (${PAYMENT_LABELS[method]})`, userId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.redirect('/sales');
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const result = await pool.query(`SELECT * FROM sales WHERE id = $1`, [req.params.id]);
  if (!result.rows.length) return res.redirect('/sales');
  if (await isPeriodClosed(result.rows[0].entry_date)) {
    return res.redirect('/sales?error=closed');
  }
  const accounts = (await pool.query(`SELECT * FROM accounts ORDER BY name`)).rows;
  const users = (await pool.query(`SELECT id, full_name FROM users WHERE active = true ORDER BY full_name`)).rows;
  res.render('transactions/form', {
    title: 'تعديل حركة — المبيعات',
    pageTitle: 'المبيعات',
    moduleKey: 'sales',
    partyLabel: 'العميل',
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
  const { entry_date, party, amount, account_id, description, payment_method, received_by_user_id } = req.body;

  if (!entry_date || !party || amount === undefined || amount === '' || isNaN(Number(amount))) {
    return res.redirect('/sales?error=invalid');
  }
  const method = VALID_METHODS.includes(payment_method) ? payment_method : 'cash';
  if (method === 'bank' && !account_id) {
    return res.redirect('/sales?error=invalid');
  }

  const existing = await pool.query(`SELECT entry_date FROM sales WHERE id = $1`, [req.params.id]);
  if (!existing.rows.length) return res.redirect('/sales');
  if ((await isPeriodClosed(existing.rows[0].entry_date)) || (await isPeriodClosed(entry_date))) {
    return res.redirect('/sales?error=closed');
  }

  const finalAccountId = method === 'bank' ? account_id : null;
  const finalReceivedBy = method === 'cash' ? (received_by_user_id || null) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE sales SET entry_date=$1, party=$2, amount=$3, account_id=$4, description=$5, payment_method=$6, received_by_user_id=$7 WHERE id=$8`,
      [entry_date, party, amount, finalAccountId, description || null, method, finalReceivedBy, req.params.id]
    );
    await client.query(
      `UPDATE treasury_ledger SET entry_date=$1, amount=$2, description=$3
       WHERE source_module = 'sales' AND source_id = $4`,
      [entry_date, amount, `المبيعات — ${party} (${PAYMENT_LABELS[method]})`, req.params.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.redirect('/sales');
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  const existing = await pool.query(`SELECT entry_date FROM sales WHERE id = $1`, [req.params.id]);
  if (!existing.rows.length) return res.redirect('/sales');
  if (await isPeriodClosed(existing.rows[0].entry_date)) {
    return res.redirect('/sales?error=closed');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM treasury_ledger WHERE source_module = 'sales' AND source_id = $1`, [req.params.id]);
    await client.query(`DELETE FROM sales WHERE id = $1`, [req.params.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.redirect('/sales');
}));

module.exports = router;
