const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requirePermission('suppliers'));

router.get('/', asyncHandler(async (req, res) => {
  const suppliers = await pool.query(`
    SELECT s.*,
      COALESCE((SELECT SUM(p.amount) FROM purchases p WHERE p.supplier_id = s.id), 0) AS total_purchases,
      (SELECT COUNT(*) FROM purchases p WHERE p.supplier_id = s.id) AS orders_count
    FROM suppliers s
    ORDER BY s.name
  `);
  res.render('suppliers', { title: 'الموردين', suppliers: suppliers.rows, error: null });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, phone, email, address, notes } = req.body;
  if (!name || !name.trim()) {
    const suppliers = await pool.query('SELECT * FROM suppliers ORDER BY name');
    return res.render('suppliers', { title: 'الموردين', suppliers: suppliers.rows, error: 'اسم المورد مطلوب' });
  }
  await pool.query(
    'INSERT INTO suppliers (name, phone, email, address, notes) VALUES ($1,$2,$3,$4,$5)',
    [name.trim(), phone || null, email || null, address || null, notes || null]
  );
  res.redirect('/suppliers');
}));

router.post('/:id', asyncHandler(async (req, res) => {
  const { name, phone, email, address, notes } = req.body;
  if (!name || !name.trim()) return res.redirect('/suppliers');
  await pool.query(
    'UPDATE suppliers SET name=$1, phone=$2, email=$3, address=$4, notes=$5 WHERE id=$6',
    [name.trim(), phone || null, email || null, address || null, notes || null, req.params.id]
  );
  res.redirect('/suppliers');
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  try {
    await pool.query('DELETE FROM suppliers WHERE id = $1', [req.params.id]);
  } catch (e) {
    // فيه مشتريات مرتبطة بالمورد ده
  }
  res.redirect('/suppliers');
}));

// تصدير بيانات الموردين لملف Excel
router.get('/export/excel', asyncHandler(async (req, res) => {
  const suppliers = await pool.query(`
    SELECT s.*,
      COALESCE((SELECT SUM(p.amount) FROM purchases p WHERE p.supplier_id = s.id), 0) AS total_purchases,
      (SELECT COUNT(*) FROM purchases p WHERE p.supplier_id = s.id) AS orders_count
    FROM suppliers s
    ORDER BY s.name
  `);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('الموردين');
  sheet.views = [{ rightToLeft: true }];
  sheet.columns = [
    { header: 'الاسم', key: 'name', width: 28 },
    { header: 'التليفون', key: 'phone', width: 18 },
    { header: 'الإيميل', key: 'email', width: 26 },
    { header: 'العنوان', key: 'address', width: 30 },
    { header: 'ملاحظات', key: 'notes', width: 30 },
    { header: 'عدد فواتير الشراء', key: 'orders_count', width: 16 },
    { header: 'إجمالي المشتريات', key: 'total_purchases', width: 18 }
  ];
  sheet.getRow(1).font = { bold: true };

  suppliers.rows.forEach(s => {
    sheet.addRow({
      name: s.name,
      phone: s.phone || '',
      email: s.email || '',
      address: s.address || '',
      notes: s.notes || '',
      orders_count: Number(s.orders_count),
      total_purchases: Number(s.total_purchases)
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="suppliers.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
}));

module.exports = router;
