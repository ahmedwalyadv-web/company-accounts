const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requirePermission('reports'));

// بيجيب كل بيانات التقرير لفترة معينة (مستخدمة في صفحة التقارير وفي تصدير الإكسل مع بعض)
async function loadReportData(from, to) {
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
    pool.query(`SELECT name, quantity_on_hand, unit_cost, (quantity_on_hand * unit_cost) AS value FROM items ORDER BY (quantity_on_hand * unit_cost) DESC`),
    pool.query(
      `SELECT sl.item_name, s.sale_type, SUM(sl.quantity) AS total_qty, SUM(sl.line_total) AS total_amount
       FROM sale_lines sl JOIN sales s ON sl.sale_id = s.id
       WHERE s.entry_date BETWEEN $1 AND $2
       GROUP BY sl.item_name, s.sale_type ORDER BY total_amount DESC`,
      [from, to]
    ),
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

  return {
    purchases: purchases.rows[0], expenses: expenses.rows[0], sales: sales.rows[0], receipts: receipts.rows[0],
    expenseByReason: expenseByReason.rows,
    purchasesList: purchasesList.rows, expensesList: expensesList.rows, salesList: salesList.rows, receiptsList: receiptsList.rows,
    totalIn, totalOut, netProfit,
    inventorySnapshot: inventorySnapshot.rows, totalInventoryValue,
    itemsSoldInRange: itemsSoldInRange.rows, assetsAddedInRange: assetsAddedInRange.rows
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = today.slice(0, 7) + '-01';
  const from = req.query.from || firstOfMonth;
  const to = req.query.to || today;
  const data = await loadReportData(from, to);
  res.render('reports', Object.assign({ title: 'التقارير', from, to }, data));
}));

// تصدير التقرير (بنفس الفترة المختارة) لملف إكسل بعدة شيتات
router.get('/export/excel', asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = today.slice(0, 7) + '-01';
  const from = req.query.from || firstOfMonth;
  const to = req.query.to || today;
  const data = await loadReportData(from, to);

  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet('الملخص');
  summary.views = [{ rightToLeft: true }];
  summary.columns = [{ header: 'البيان', key: 'k', width: 30 }, { header: 'القيمة', key: 'v', width: 20 }];
  summary.getRow(1).font = { bold: true };
  [
    ['الفترة من', from], ['الفترة إلى', to],
    ['إجمالي المشتريات', Number(data.purchases.total)],
    ['إجمالي المصروفات', Number(data.expenses.total)],
    ['إجمالي المبيعات', Number(data.sales.total)],
    ['إجمالي استلام الفلوس', Number(data.receipts.total)],
    ['إجمالي الوارد (مبيعات + استلام)', data.totalIn],
    ['إجمالي المنصرف (مشتريات + مصروفات)', data.totalOut],
    ['صافي الربح', data.netProfit],
    ['قيمة المخزون الحالية (لقطة الآن)', data.totalInventoryValue]
  ].forEach(([k, v]) => summary.addRow({ k, v }));

  function addListSheet(name, rows, columns) {
    const sheet = workbook.addWorksheet(name);
    sheet.views = [{ rightToLeft: true }];
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
    rows.forEach(r => sheet.addRow(r));
  }

  addListSheet('المشتريات', data.purchasesList.map(r => ({
    entry_date: new Date(r.entry_date).toLocaleDateString('en-GB'), party: r.party, amount: Number(r.amount),
    payment_method: r.payment_method, description: r.description || ''
  })), [
    { header: 'التاريخ', key: 'entry_date', width: 14 }, { header: 'المورد', key: 'party', width: 24 },
    { header: 'المبلغ', key: 'amount', width: 14 }, { header: 'طريقة الدفع', key: 'payment_method', width: 14 },
    { header: 'الوصف', key: 'description', width: 30 }
  ]);

  addListSheet('المصروفات', data.expensesList.map(r => ({
    entry_date: new Date(r.entry_date).toLocaleDateString('en-GB'), party: r.party, reason: r.reason || '',
    amount: Number(r.amount), description: r.description || ''
  })), [
    { header: 'التاريخ', key: 'entry_date', width: 14 }, { header: 'المستلم', key: 'party', width: 24 },
    { header: 'السبب', key: 'reason', width: 18 }, { header: 'المبلغ', key: 'amount', width: 14 },
    { header: 'الوصف', key: 'description', width: 30 }
  ]);

  addListSheet('المبيعات', data.salesList.map(r => ({
    entry_date: new Date(r.entry_date).toLocaleDateString('en-GB'), party: r.party, amount: Number(r.amount),
    payment_method: r.payment_method, description: r.description || ''
  })), [
    { header: 'التاريخ', key: 'entry_date', width: 14 }, { header: 'العميل', key: 'party', width: 24 },
    { header: 'المبلغ', key: 'amount', width: 14 }, { header: 'طريقة التحصيل', key: 'payment_method', width: 14 },
    { header: 'الوصف', key: 'description', width: 30 }
  ]);

  addListSheet('استلام فلوس', data.receiptsList.map(r => ({
    entry_date: new Date(r.entry_date).toLocaleDateString('en-GB'), party: r.party, amount: Number(r.amount),
    description: r.description || ''
  })), [
    { header: 'التاريخ', key: 'entry_date', width: 14 }, { header: 'الطرف', key: 'party', width: 24 },
    { header: 'المبلغ', key: 'amount', width: 14 }, { header: 'الوصف', key: 'description', width: 30 }
  ]);

  addListSheet('تقييم المخزون الحالي', data.inventorySnapshot.map(r => ({
    name: r.name, quantity_on_hand: Number(r.quantity_on_hand), unit_cost: Number(r.unit_cost), value: Number(r.value)
  })), [
    { header: 'الصنف', key: 'name', width: 26 }, { header: 'الكمية المتاحة', key: 'quantity_on_hand', width: 16 },
    { header: 'متوسط تكلفة الوحدة', key: 'unit_cost', width: 18 }, { header: 'القيمة', key: 'value', width: 16 }
  ]);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="report-${from}-to-${to}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}));

module.exports = router;
