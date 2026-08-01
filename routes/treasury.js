const express = require('express');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requirePermission('treasury'));

router.get('/', asyncHandler(async (req, res) => {
  const ledger = await pool.query(`
    SELECT tl.*, u.full_name AS created_by_name
    FROM treasury_ledger tl
    LEFT JOIN users u ON tl.created_by = u.id
    ORDER BY tl.entry_date DESC, tl.id DESC LIMIT 300
  `);
  const balanceResult = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS balance FROM treasury_ledger`
  );
  const totalsResult = await pool.query(`
    SELECT
      COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0) AS total_in,
      COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) AS total_out
    FROM treasury_ledger
  `);
  const reconciliations = await pool.query(`
    SELECT r.*, u.full_name AS created_by_name
    FROM treasury_reconciliations r
    LEFT JOIN users u ON r.created_by = u.id
    ORDER BY r.recon_date DESC, r.id DESC LIMIT 50
  `);
  res.render('treasury', {
    title: 'الخزنة',
    ledger: ledger.rows,
    balance: balanceResult.rows[0].balance,
    totals: totalsResult.rows[0],
    reconciliations: reconciliations.rows
  });
}));

// تسوية / إضافة رصيد يدوي للخزنة (مثلاً رأس مال أول المدة)
router.post('/adjust', asyncHandler(async (req, res) => {
  const { entry_date, direction, amount, description } = req.body;
  if (!entry_date || !direction || amount === undefined || amount === '' || isNaN(Number(amount))) {
    return res.redirect('/treasury');
  }
  await pool.query(
    `INSERT INTO treasury_ledger (entry_date, direction, amount, source_module, description, created_by)
     VALUES ($1,$2,$3,'adjustment',$4,$5)`,
    [entry_date, direction, amount, description || 'تسوية يدوية', req.session.user.id]
  );
  res.redirect('/treasury');
}));

// تسوية الخزنة: مقارنة الرصيد الفعلي بالعد بالرصيد المسجل في النظام،
// وتسجيل الفرق تلقائيًا كحركة تصحيح في الخزنة
router.post('/reconcile', asyncHandler(async (req, res) => {
  const { recon_date, actual_balance, notes } = req.body;
  if (!recon_date || actual_balance === undefined || actual_balance === '' || isNaN(Number(actual_balance))) {
    return res.redirect('/treasury');
  }
  const userId = req.session.user.id;

  const balanceResult = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS balance FROM treasury_ledger`
  );
  const systemBalance = Number(balanceResult.rows[0].balance);
  const actualBalance = Number(actual_balance);
  const difference = actualBalance - systemBalance;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO treasury_reconciliations (recon_date, system_balance, actual_balance, difference, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [recon_date, systemBalance, actualBalance, difference, notes || null, userId]
    );
    if (Math.abs(difference) > 0.001) {
      await client.query(
        `INSERT INTO treasury_ledger (entry_date, direction, amount, source_module, source_id, description, created_by)
         VALUES ($1,$2,$3,'reconciliation',$4,$5,$6)`,
        [
          recon_date,
          difference > 0 ? 'in' : 'out',
          Math.abs(difference),
          inserted.rows[0].id,
          `تسوية خزنة — تصحيح فرق العد الفعلي${notes ? ' (' + notes + ')' : ''}`,
          userId
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.redirect('/treasury');
}));

module.exports = router;
