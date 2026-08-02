const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requirePermission('customers'));

router.get('/', asyncHandler(async (req, res) => {
  const customers = await pool.query(`
    SELECT c.*,
      COALESCE((SELECT SUM(s.amount) FROM sales s WHERE s.customer_id = c.id), 0) AS total_sales,
      (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id) AS orders_count
    FROM customers c
    ORDER BY c.name
  `);
  res.render('customers', { title: 'العملاء', customers: customers.rows, error: null });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, phone, email, address, notes } = req.body;
  if (!name || !name.trim()) {
    const customers = await pool.query('SELECT * FROM customers ORDER BY name');
    return res.render('customers', { title: 'العملاء', customers: customers.rows, error: 'اسم العميل مطلوب' });
  }
  await pool.query(
    'INSERT INTO customers (name, phone, email, address, notes) VALUES ($1,$2,$3,$4,$5)',
    [name.trim(), phone || null, email || null, address || null, notes || null]
  );
  res.redirect('/customers');
}));

router.post('/:id', asyncHandler(async (req, res) => {
  const { name, phone, email, address, notes } = req.body;
  if (!name || !name.trim()) return res.redirect('/customers');
  await pool.query(
    'UPDATE customers SET name=$1, phone=$2, email=$3, address=$4, notes=$5 WHERE id=$6',
    [name.trim(), phone || null, email || null, address || null, notes || null, req.params.id]
  );
  res.redirect('/customers');
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  try {
    await pool.query('DELETE FROM customers WHERE id = $1', [req.params.id]);
  } catch (e) {
    // فيه مبيعات مرتبطة بالعميل ده
  }
  res.redirect('/customers');
}));

// تصدير بيانات العملاء لملف Excel
router.get('/export/excel', asyncHandler(async (req, res) => {
  const customers = await pool.query(`
    SELECT c.*,
      COALESCE((SELECT SUM(s.amount) FROM sales s WHERE s.customer_id = c.id), 0) AS total_sales,
      (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id) AS orders_count
    FROM customers c
    ORDER BY c.name
  `);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('العملاء');
  sheet.views = [{ rightToLeft: true }];
  sheet.columns = [
    { header: 'الاسم', key: 'name', width: 28 },
    { header: 'التليفون', key: 'phone', width: 18 },
    { header: 'الإيميل', key: 'email', width: 26 },
    { header: 'العنوان', key: 'address', width: 30 },
    { header: 'ملاحظات', key: 'notes', width: 30 },
    { header: 'عدد الفواتير', key: 'orders_count', width: 14 },
    { header: 'إجمالي المبيعات', key: 'total_sales', width: 18 }
  ];
  sheet.getRow(1).font = { bold: true };

  customers.rows.forEach(c => {
    sheet.addRow({
      name: c.name,
      phone: c.phone || '',
      email: c.email || '',
      address: c.address || '',
      notes: c.notes || '',
      orders_count: Number(c.orders_count),
      total_sales: Number(c.total_sales)
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="customers.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
}));

module.exports = router;
