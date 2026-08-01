const express = require('express');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requirePermission('reports'));

router.get('/', asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = today.slice(0, 7) + '-01';
  const from = req.query.from || firstOfMonth;
  const to = req.query.to || today;

  const [purchases, expenses, sales, receipts, expenseByReason, purchasesList, expensesList, salesList, receiptsList] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM purchases WHERE entry_date BETWEEN $1 AND $2`, [from, to]),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM expenses WHERE entry_date BETWEEN $1 AND $2`, [from, to]),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM sales WHERE entry_date BETWEEN $1 AND $2`, [from, to]),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM receipts WHERE entry_date BETWEEN $1 AND $2`, [from, to]),
    pool.query(
      `SELECT reason, COALESCE(SUM(amount),0) AS total FROM expenses
       WHERE entry_date BETWEEN $1 AND $2 GROUP BY reason ORDER BY total DESC`,
      [from, to]
    ),
    pool.query(`SELECT entry_date, party, amount, description, payment_method FROM purchases WHERE entry_date BETWEEN $1 AND $2 ORDER BY entry_date`, [from, to]),
    pool.query(`SELECT entry_date, party, reason, amount, description FROM expenses WHERE entry_date BETWEEN $1 AND $2 ORDER BY entry_date`, [from, to]),
    pool.query(`SELECT entry_date, party, amount, description, payment_method FROM sales WHERE entry_date BETWEEN $1 AND $2 ORDER BY entry_date`, [from, to]),
    pool.query(`SELECT entry_date, party, amount, description FROM receipts WHERE entry_date BETWEEN $1 AND $2 ORDER BY entry_date`, [from, to])
  ]);

  const totalIn = Number(sales.rows[0].total) + Number(receipts.rows[0].total);
  const totalOut = Number(purchases.rows[0].total) + Number(expenses.rows[0].total);
  const netProfit = totalIn - totalOut;

  res.render('reports', {
    title: 'التقارير',
    from,
    to,
    purchases: purchases.rows[0],
    expenses: expenses.rows[0],
    sales: sales.rows[0],
    receipts: receipts.rows[0],
    expenseByReason: expenseByReason.rows,
    purchasesList: purchasesList.rows,
    expensesList: expensesList.rows,
    salesList: salesList.rows,
    receiptsList: receiptsList.rows,
    totalIn,
    totalOut,
    netProfit
  });
}));

module.exports = router;
