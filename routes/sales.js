const express = require('express');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const { isPeriodClosed } = require('../db/periodLock');
const asyncHandler = require('../middleware/asyncHandler');
const { findOrCreateItem, applyStockMovement, reverseMovementsForSource } = require('../db/inventory');

const router = express.Router();
router.use(requirePermission('sales'));

const PAYMENT_METHODS = [
  { value: 'cash', label: 'كاش' },
  { value: 'bank', label: 'حساب بنكي' }
];
const PAYMENT_LABELS = Object.fromEntries(PAYMENT_METHODS.map(p => [p.value, p.label]));
const VALID_METHODS = PAYMENT_METHODS.map(p => p.value);

const SALE_TYPES = [
  { value: 'sale', label: 'بيع' },
  { value: 'rental', label: 'إيجار' }
];
const SALE_TYPE_LABELS = Object.fromEntries(SALE_TYPES.map(s => [s.value, s.label]));
const VALID_SALE_TYPES = SALE_TYPES.map(s => s.value);

function parseLines(body) {
  const raw = body.lines || {};
  const items = Array.isArray(raw) ? raw : Object.values(raw);
  const lines = [];
  for (const line of items) {
    if (!line) continue;
    const name = (line.item_name || '').trim();
    if (!name) continue;
    const qty = Number(line.quantity);
    const price = Number(line.unit_price);
    if (!qty || qty <= 0 || isNaN(price) || price < 0) continue;
    lines.push({
      item_name: name,
      quantity: qty,
      unit_price: price,
      line_total: Math.round(qty * price * 100) / 100
    });
  }
  return lines;
}

async function fetchListRows() {
  const result = await pool.query(
    `SELECT t.*, u.full_name AS created_by_name, r.full_name AS received_by_name, a.name AS account_name,
       c.name AS customer_name,
       (SELECT COUNT(*) FROM sale_lines sl WHERE sl.sale_id = t.id) AS lines_count,
       (SELECT string_agg(sl.item_name || ' ×' || sl.quantity, '، ') FROM sale_lines sl WHERE sl.sale_id = t.id) AS items_summary
     FROM sales t
     LEFT JOIN users u ON t.created_by = u.id
     LEFT JOIN users r ON t.received_by_user_id = r.id
     LEFT JOIN accounts a ON t.account_id = a.id
     LEFT JOIN customers c ON t.customer_id = c.id
     WHERE NOT EXISTS (
       SELECT 1 FROM monthly_closings mc WHERE mc.period = date_trunc('month', t.entry_date)::date
     )
     ORDER BY t.entry_date DESC, t.id DESC LIMIT 300`
  );
  return result.rows;
}

router.get('/', asyncHandler(async (req, res) => {
  const rows = await fetchListRows();
  const totalResult = await pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM sales`);
  res.render('sales/list', {
    title: 'المبيعات',
    paymentLabels: PAYMENT_LABELS,
    saleTypeLabels: SALE_TYPE_LABELS,
    rows,
    total: totalResult.rows[0].total,
    error: req.query.error === 'closed'
      ? 'الشهر ده مقفول (تم عمل تقفيل شهري ليه)، مينفعش تضيف أو تعدل أو تحذف حركات فيه. لو محتاج تعدل، لازم الأدمن يفتح الشهر تاني من صفحة التقفيل الشهري.'
      : (req.query.error === 'invalid' ? 'البيانات المدخلة ناقصة أو غير صحيحة، برجاء إضافة صنف واحد على الأقل واختيار طريقة التحصيل الصحيحة.'
        : (req.query.error === 'stock' ? 'الكمية المطلوبة من أحد الأصناف أكبر من المتاح في المخزون.' : null))
  });
}));

router.get('/new', asyncHandler(async (req, res) => {
  const accounts = (await pool.query(`SELECT * FROM accounts ORDER BY name`)).rows;
  const users = (await pool.query(`SELECT id, full_name FROM users WHERE active = true ORDER BY full_name`)).rows;
  const items = (await pool.query(`SELECT id, name, quantity_on_hand FROM items ORDER BY name`)).rows;
  const customers = (await pool.query(`SELECT id, name FROM customers ORDER BY name`)).rows;
  res.render('sales/form', {
    title: 'إضافة فاتورة بيع/إيجار',
    accounts,
    users,
    items,
    customers,
    paymentMethods: PAYMENT_METHODS,
    saleTypes: SALE_TYPES,
    invoice: null,
    lines: [],
    today: new Date().toISOString().slice(0, 10),
    error: null
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { entry_date, party, payment_method, account_id, received_by_user_id, description, sale_type, customer_id } = req.body;
  const lines = parseLines(req.body);
  const method = VALID_METHODS.includes(payment_method) ? payment_method : 'cash';
  const type = VALID_SALE_TYPES.includes(sale_type) ? sale_type : 'sale';

  if (!entry_date || !party || !lines.length) {
    return res.redirect('/sales?error=invalid');
  }
  if (method === 'bank' && !account_id) {
    return res.redirect('/sales?error=invalid');
  }
  if (await isPeriodClosed(entry_date)) {
    return res.redirect('/sales?error=closed');
  }

  const amount = Math.round(lines.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
  const userId = req.session.user.id;
  const finalAccountId = method === 'bank' ? account_id : null;
  const finalReceivedBy = method === 'cash' ? (received_by_user_id || null) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO sales (entry_date, party, amount, account_id, description, payment_method, received_by_user_id, sale_type, customer_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [entry_date, party, amount, finalAccountId, description || null, method, finalReceivedBy, type, customer_id || null, userId]
    );
    const saleId = inserted.rows[0].id;

    for (const line of lines) {
      const item = await findOrCreateItem(client, line.item_name);
      if (type === 'sale') {
        // البيع بينقص من المخزون فعليًا، الإيجار لا
        await applyStockMovement(client, {
          itemId: item.id,
          quantity: line.quantity,
          direction: 'out',
          entryDate: entry_date,
          sourceModule: 'sales',
          sourceId: saleId,
          description: `فاتورة بيع #${saleId} — ${party}`,
          userId,
          allowNegative: true // نسمح بالسالب حاليًا مع تنبيه بصري في صفحة المخزون بدل رفض العملية
        });
      }
      await client.query(
        `INSERT INTO sale_lines (sale_id, item_id, item_name, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [saleId, item.id, line.item_name, line.quantity, line.unit_price, line.line_total]
      );
    }

    await client.query(
      `INSERT INTO treasury_ledger (entry_date, direction, amount, source_module, source_id, description, created_by)
       VALUES ($1,'in',$2,'sales',$3,$4,$5)`,
      [entry_date, amount, saleId, `المبيعات — ${party} (${PAYMENT_LABELS[method]}, ${SALE_TYPE_LABELS[type]})`, userId]
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
  const linesResult = await pool.query(`SELECT * FROM sale_lines WHERE sale_id = $1 ORDER BY id`, [req.params.id]);
  const accounts = (await pool.query(`SELECT * FROM accounts ORDER BY name`)).rows;
  const users = (await pool.query(`SELECT id, full_name FROM users WHERE active = true ORDER BY full_name`)).rows;
  const items = (await pool.query(`SELECT id, name, quantity_on_hand FROM items ORDER BY name`)).rows;
  const customers = (await pool.query(`SELECT id, name FROM customers ORDER BY name`)).rows;
  res.render('sales/form', {
    title: 'تعديل فاتورة بيع/إيجار',
    accounts,
    users,
    items,
    customers,
    paymentMethods: PAYMENT_METHODS,
    saleTypes: SALE_TYPES,
    invoice: result.rows[0],
    lines: linesResult.rows,
    today: new Date().toISOString().slice(0, 10),
    error: null
  });
}));

router.post('/:id', asyncHandler(async (req, res) => {
  const { entry_date, party, payment_method, account_id, received_by_user_id, description, sale_type, customer_id } = req.body;
  const lines = parseLines(req.body);
  const method = VALID_METHODS.includes(payment_method) ? payment_method : 'cash';
  const type = VALID_SALE_TYPES.includes(sale_type) ? sale_type : 'sale';

  if (!entry_date || !party || !lines.length) {
    return res.redirect('/sales?error=invalid');
  }
  if (method === 'bank' && !account_id) {
    return res.redirect('/sales?error=invalid');
  }
  const existing = await pool.query(`SELECT entry_date FROM sales WHERE id = $1`, [req.params.id]);
  if (!existing.rows.length) return res.redirect('/sales');
  if ((await isPeriodClosed(existing.rows[0].entry_date)) || (await isPeriodClosed(entry_date))) {
    return res.redirect('/sales?error=closed');
  }

  const amount = Math.round(lines.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
  const userId = req.session.user.id;
  const saleId = req.params.id;
  const finalAccountId = method === 'bank' ? account_id : null;
  const finalReceivedBy = method === 'cash' ? (received_by_user_id || null) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await reverseMovementsForSource(client, 'sales', saleId);
    await client.query(`DELETE FROM sale_lines WHERE sale_id = $1`, [saleId]);

    await client.query(
      `UPDATE sales SET entry_date=$1, party=$2, amount=$3, account_id=$4, description=$5, payment_method=$6, received_by_user_id=$7, sale_type=$8, customer_id=$9 WHERE id=$10`,
      [entry_date, party, amount, finalAccountId, description || null, method, finalReceivedBy, type, customer_id || null, saleId]
    );

    for (const line of lines) {
      const item = await findOrCreateItem(client, line.item_name);
      if (type === 'sale') {
        await applyStockMovement(client, {
          itemId: item.id,
          quantity: line.quantity,
          direction: 'out',
          entryDate: entry_date,
          sourceModule: 'sales',
          sourceId: saleId,
          description: `فاتورة بيع #${saleId} — ${party}`,
          userId,
          allowNegative: true
        });
      }
      await client.query(
        `INSERT INTO sale_lines (sale_id, item_id, item_name, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [saleId, item.id, line.item_name, line.quantity, line.unit_price, line.line_total]
      );
    }

    await client.query(
      `UPDATE treasury_ledger SET entry_date=$1, amount=$2, description=$3
       WHERE source_module = 'sales' AND source_id = $4`,
      [entry_date, amount, `المبيعات — ${party} (${PAYMENT_LABELS[method]}, ${SALE_TYPE_LABELS[type]})`, saleId]
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
    await reverseMovementsForSource(client, 'sales', req.params.id);
    await client.query(`DELETE FROM treasury_ledger WHERE source_module = 'sales' AND source_id = $1`, [req.params.id]);
    await client.query(`DELETE FROM sales WHERE id = $1`, [req.params.id]); // بنود الفاتورة بتحذف تلقائي (CASCADE)
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
