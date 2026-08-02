const express = require('express');
const pool = require('../db/pool');
const { requireLogin } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

router.get('/', requireLogin, asyncHandler(async (req, res) => {
  const [purchases, expenses, sales, receipts, treasuryBalance, inventoryValue, recent] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM purchases WHERE entry_date >= date_trunc('month', CURRENT_DATE)`),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE entry_date >= date_trunc('month', CURRENT_DATE)`),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM sales WHERE entry_date >= date_trunc('month', CURRENT_DATE)`),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM receipts WHERE entry_date >= date_trunc('month', CURRENT_DATE)`),
    pool.query(`SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS balance FROM treasury_ledger`),
    pool.query(`SELECT COALESCE(SUM(quantity_on_hand * unit_cost),0) AS total FROM items`),
    pool.query(`
      SELECT * FROM (
        SELECT 'purchases' AS module, entry_date, party, amount, created_at FROM purchases
        UNION ALL
        SELECT 'expenses', entry_date, party, amount, created_at FROM expenses
        UNION ALL
        SELECT 'sales', entry_date, party, amount, created_at FROM sales
        UNION ALL
        SELECT 'receipts', entry_date, party, amount, created_at FROM receipts
      ) t ORDER BY created_at DESC LIMIT 10
    `)
  ]);

  res.render('dashboard', {
    title: 'الرئيسية',
    stats: {
      purchases: purchases.rows[0].total,
      expenses: expenses.rows[0].total,
      sales: sales.rows[0].total,
      receipts: receipts.rows[0].total,
      treasury: treasuryBalance.rows[0].balance,
      inventoryValue: inventoryValue.rows[0].total
    },
    recent: recent.rows
  });
}));

module.exports = router;
