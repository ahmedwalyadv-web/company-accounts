const express = require('express');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requirePermission('closing'));

const MONTH_REGEX = /^\d{4}-\d{2}$/;

// بيحسب إجماليات شهر معين (مشتريات/مصروفات/مبيعات/استلام فلوس وصافي الربح)
async function computeMonthTotals(periodDate) {
  const range = `entry_date >= date_trunc('month', $1::date) AND entry_date < date_trunc('month', $1::date) + interval '1 month'`;
  const [p, e, s, r] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM purchases WHERE ${range}`, [periodDate]),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE ${range}`, [periodDate]),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM sales WHERE ${range}`, [periodDate]),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM receipts WHERE ${range}`, [periodDate])
  ]);
  const total_purchases = Number(p.rows[0].total);
  const total_expenses = Number(e.rows[0].total);
  const total_sales = Number(s.rows[0].total);
  const total_receipts = Number(r.rows[0].total);
  const net_profit = (total_sales + total_receipts) - (total_purchases + total_expenses);
  return { total_purchases, total_expenses, total_sales, total_receipts, net_profit };
}

router.get('/', asyncHandler(async (req, res) => {
  const closings = await pool.query(`
    SELECT c.*, u.full_name AS closed_by_name
    FROM monthly_closings c LEFT JOIN users u ON c.closed_by = u.id
    ORDER BY period DESC
  `);

  let month = req.query.month || new Date().toISOString().slice(0, 7);
  if (!MONTH_REGEX.test(month)) {
    month = new Date().toISOString().slice(0, 7);
  }
  const periodDate = month + '-01';

  const existing = await pool.query(
    `SELECT * FROM monthly_closings WHERE period = date_trunc('month', $1::date)::date`,
    [periodDate]
  );

  let preview = null;
  const alreadyClosed = existing.rows.length > 0;
  if (!alreadyClosed) {
    preview = await computeMonthTotals(periodDate);
  }

  res.render('closing', {
    title: 'التقفيل الشهري',
    closings: closings.rows,
    month,
    preview,
    alreadyClosed
  });
}));

router.post('/close', asyncHandler(async (req, res) => {
  const { month, notes } = req.body;
  if (!month || !MONTH_REGEX.test(month)) {
    return res.redirect('/closing');
  }
  const periodDate = month + '-01';

  const existing = await pool.query(
    `SELECT * FROM monthly_closings WHERE period = date_trunc('month', $1::date)::date`,
    [periodDate]
  );
  if (existing.rows.length) {
    return res.redirect('/closing?month=' + month);
  }

  const totals = await computeMonthTotals(periodDate);
  await pool.query(
    `INSERT INTO monthly_closings (period, total_purchases, total_expenses, total_sales, total_receipts, net_profit, notes, closed_by)
     VALUES (date_trunc('month', $1::date)::date, $2,$3,$4,$5,$6,$7,$8)`,
    [periodDate, totals.total_purchases, totals.total_expenses, totals.total_sales, totals.total_receipts, totals.net_profit, notes || null, req.session.user.id]
  );
  res.redirect('/closing');
}));

// إعادة فتح شهر مقفول — للأدمن بس
router.post('/:id/reopen', asyncHandler(async (req, res) => {
  if (!req.session.user.is_admin) {
    return res.status(403).render('403', { title: 'غير مصرح' });
  }
  await pool.query('DELETE FROM monthly_closings WHERE id = $1', [req.params.id]);
  res.redirect('/closing');
}));

module.exports = router;
