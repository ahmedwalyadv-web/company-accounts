const express = require('express');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(requirePermission('treasury'));

router.get('/', async (req, res) => {
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
  res.render('treasury', {
    title: 'الخزنة',
    ledger: ledger.rows,
    balance: balanceResult.rows[0].balance,
    totals: totalsResult.rows[0]
  });
});

// تسوية / إضافة رصيد يدوي للخزنة (مثلاً رأس مال أول المدة)
router.post('/adjust', async (req, res) => {
  const { entry_date, direction, amount, description } = req.body;
  await pool.query(
    `INSERT INTO treasury_ledger (entry_date, direction, amount, source_module, description, created_by)
     VALUES ($1,$2,$3,'adjustment',$4,$5)`,
    [entry_date, direction, amount, description || 'تسوية يدوية', req.session.user.id]
  );
  res.redirect('/treasury');
});

module.exports = router;
