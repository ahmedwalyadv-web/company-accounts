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

  const [purchases, expenses, sales, receipts, expenseByReason, purchasesList, expensesList, salesList, receiptsList,
    inventorySnapshot, itemsSoldInRange, assetsAddedInRange] = await Promise.all([
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
    pool.query(`SELECT entry_date, party, amount, description FROM receipts WHERE entry_date BETWEEN $1 AND $2 ORDER BY entry_date`, [from, to]),
    // تقييم المخزون الحالي (لقطة لحظية، مش مرتبطة بالفترة المختارة)
    pool.query(`SELECT name, quantity_on_hand, unit_cost, (quantity_on_hand * unit_cost) AS value FROM items ORDER BY (quantity_on_hand * unit_cost) DESC`),
    // الأصناف اللي تم بيعها/تأجيرها في الفترة المختارة
    pool.query(
      `SELECT sl.item_name, s.sale_type, SUM(sl.quantity) AS total_qty, SUM(sl.line_total) AS total_amount
       FROM sale_lines sl JOIN sales s ON sl.sale_id = s.id
       WHERE s.entry_date BETWEEN $1 AND $2
       GROUP BY sl.item_name, s.sale_type ORDER BY total_amount DESC`,
      [from, to]
    ),
    // الأصناف/الأصول اللي دخلت المخزون من المشتريات في الفترة المختارة
    pool.query(
      `SELECT pl.item_name, SUM(pl.quantity) AS total_qty, SUM(pl.line_total) AS total_amount
       FROM purchase_lines pl JOIN purchases p ON pl.purchase_id = p.id
       WHERE pl.is_asset = true AND p.entry_date BETWEEN $1 AND $2
       GROUP BY pl.item_name ORDER BY total_amount DESC`,
      [from, to]
    )
  ]);

  const totalIn = Number(sales.rows[0].total) + Number(receipts.rows[0].total);
  const totalOut = Number(purchases.rows[0].total) + Number(expenses.rows[0].total);
  const netProfit = totalIn - totalOut;
  const totalInventoryValue = inventorySnapshot.rows.reduce((s, r) => s + Number(r.value), 0);

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
    netProfit,
    inventorySnapshot: inventorySnapshot.rows,
    totalInventoryValue,
    itemsSoldInRange: itemsSoldInRange.rows,
    assetsAddedInRange: assetsAddedInRange.rows
  });
}));

module.exports = router;
