const express = require('express');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const { isPeriodClosed } = require('../db/periodLock');
const asyncHandler = require('../middleware/asyncHandler');
const { findOrCreateItem, applyStockMovement, reverseMovementsForSource } = require('../db/inventory');

const router = express.Router();
router.use(requirePermission('purchases'));

const PAYMENT_METHODS = [
  { value: 'cash', label: 'كاش' },
  { value: 'visa', label: 'فيزا' },
  { value: 'network', label: 'شبكة' }
];
const PAYMENT_LABELS = Object.fromEntries(PAYMENT_METHODS.map(p => [p.value, p.label]));
const VALID_METHODS = PAYMENT_METHODS.map(p => p.value);

// بيحول بيانات الأصناف الجاية من الفورم (lines[idx][field] عشان اختيار "جهاز/أصل" مايبوظش ترتيب الصفوف
// لو بعض الصفوف مش متحدد فيها الجيك بوكس، لأن المتصفح مابيبعتش قيمة الشيك بوكس لو مش متحدد)
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
      is_asset: line.is_asset === 'on' || line.is_asset === 'true' || line.is_asset === true,
      quantity: qty,
      unit_price: price,
      line_total: Math.round(qty * price * 100) / 100
    });
  }
  return lines;
}

async function fetchListRows() {
  const result = await pool.query(
    `SELECT t.*, u.full_name AS created_by_name, p.full_name AS paid_by_name,
       (SELECT COUNT(*) FROM purchase_lines pl WHERE pl.purchase_id = t.id) AS lines_count,
       (SELECT COUNT(*) FROM purchase_lines pl WHERE pl.purchase_id = t.id AND pl.is_asset) AS assets_count,
       (SELECT string_agg(pl.item_name || ' ×' || pl.quantity, '، ') FROM purchase_lines pl WHERE pl.purchase_id = t.id) AS items_summary
     FROM purchases t
     LEFT JOIN users u ON t.created_by = u.id
     LEFT JOIN users p ON t.paid_by_user_id = p.id
     WHERE NOT EXISTS (
       SELECT 1 FROM monthly_closings mc WHERE mc.period = date_trunc('month', t.entry_date)::date
     )
     ORDER BY t.entry_date DESC, t.id DESC LIMIT 300`
  );
  return result.rows;
}

router.get('/', asyncHandler(async (req, res) => {
  const rows = await fetchListRows();
  const totalResult = await pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM purchases`);
  res.render('purchases/list', {
    title: 'المشتريات',
    paymentLabels: PAYMENT_LABELS,
    rows,
    total: totalResult.rows[0].total,
    error: req.query.error === 'closed'
      ? 'الشهر ده مقفول (تم عمل تقفيل شهري ليه)، مينفعش تضيف أو تعدل أو تحذف حركات فيه. لو محتاج تعدل، لازم الأدمن يفتح الشهر تاني من صفحة التقفيل الشهري.'
      : (req.query.error === 'invalid' ? 'البيانات المدخلة ناقصة أو غير صحيحة، برجاء إضافة صنف واحد على الأقل بكمية وسعر صحيحين.' : null)
  });
}));

router.get('/new', asyncHandler(async (req, res) => {
  const users = (await pool.query(`SELECT id, full_name FROM users WHERE active = true ORDER BY full_name`)).rows;
  const items = (await pool.query(`SELECT id, name FROM items ORDER BY name`)).rows;
  res.render('purchases/form', {
    title: 'إضافة فاتورة شراء',
    users,
    items,
    paymentMethods: PAYMENT_METHODS,
    invoice: null,
    lines: [],
    today: new Date().toISOString().slice(0, 10),
    error: null
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { entry_date, party, payment_method, paid_by_user_id, description } = req.body;
  const lines = parseLines(req.body);
  const method = VALID_METHODS.includes(payment_method) ? payment_method : 'cash';

  if (!entry_date || !party || !lines.length) {
    return res.redirect('/purchases?error=invalid');
  }
  if (await isPeriodClosed(entry_date)) {
    return res.redirect('/purchases?error=closed');
  }

  const amount = Math.round(lines.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
  const userId = req.session.user.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO purchases (entry_date, party, amount, description, payment_method, paid_by_user_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [entry_date, party, amount, description || null, method, paid_by_user_id || null, userId]
    );
    const purchaseId = inserted.rows[0].id;

    for (const line of lines) {
      let itemId = null;
      if (line.is_asset) {
        const item = await findOrCreateItem(client, line.item_name);
        itemId = item.id;
        await applyStockMovement(client, {
          itemId,
          quantity: line.quantity,
          direction: 'in',
          unitCost: line.unit_price,
          entryDate: entry_date,
          sourceModule: 'purchases',
          sourceId: purchaseId,
          description: `فاتورة شراء #${purchaseId} — ${party}`,
          userId
        });
      }
      await client.query(
        `INSERT INTO purchase_lines (purchase_id, is_asset, item_id, item_name, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [purchaseId, line.is_asset, itemId, line.item_name, line.quantity, line.unit_price, line.line_total]
      );
    }

    await client.query(
      `INSERT INTO treasury_ledger (entry_date, direction, amount, source_module, source_id, description, created_by)
       VALUES ($1,'out',$2,'purchases',$3,$4,$5)`,
      [entry_date, amount, purchaseId, `المشتريات — ${party} (${PAYMENT_LABELS[method]})`, userId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.redirect('/purchases');
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const result = await pool.query(`SELECT * FROM purchases WHERE id = $1`, [req.params.id]);
  if (!result.rows.length) return res.redirect('/purchases');
  if (await isPeriodClosed(result.rows[0].entry_date)) {
    return res.redirect('/purchases?error=closed');
  }
  const linesResult = await pool.query(`SELECT * FROM purchase_lines WHERE purchase_id = $1 ORDER BY id`, [req.params.id]);
  const users = (await pool.query(`SELECT id, full_name FROM users WHERE active = true ORDER BY full_name`)).rows;
  const items = (await pool.query(`SELECT id, name FROM items ORDER BY name`)).rows;
  res.render('purchases/form', {
    title: 'تعديل فاتورة شراء',
    users,
    items,
    paymentMethods: PAYMENT_METHODS,
    invoice: result.rows[0],
    lines: linesResult.rows,
    today: new Date().toISOString().slice(0, 10),
    error: null
  });
}));

router.post('/:id', asyncHandler(async (req, res) => {
  const { entry_date, party, payment_method, paid_by_user_id, description } = req.body;
  const lines = parseLines(req.body);
  const method = VALID_METHODS.includes(payment_method) ? payment_method : 'cash';

  if (!entry_date || !party || !lines.length) {
    return res.redirect('/purchases?error=invalid');
  }
  const existing = await pool.query(`SELECT entry_date FROM purchases WHERE id = $1`, [req.params.id]);
  if (!existing.rows.length) return res.redirect('/purchases');
  if ((await isPeriodClosed(existing.rows[0].entry_date)) || (await isPeriodClosed(entry_date))) {
    return res.redirect('/purchases?error=closed');
  }

  const amount = Math.round(lines.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
  const userId = req.session.user.id;
  const purchaseId = req.params.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // نرجع أي حركات مخزون كانت مرتبطة بالفاتورة القديمة قبل ما نعمل التعديل
    await reverseMovementsForSource(client, 'purchases', purchaseId);
    await client.query(`DELETE FROM purchase_lines WHERE purchase_id = $1`, [purchaseId]);

    await client.query(
      `UPDATE purchases SET entry_date=$1, party=$2, amount=$3, description=$4, payment_method=$5, paid_by_user_id=$6 WHERE id=$7`,
      [entry_date, party, amount, description || null, method, paid_by_user_id || null, purchaseId]
    );

    for (const line of lines) {
      let itemId = null;
      if (line.is_asset) {
        const item = await findOrCreateItem(client, line.item_name);
        itemId = item.id;
        await applyStockMovement(client, {
          itemId,
          quantity: line.quantity,
          direction: 'in',
          unitCost: line.unit_price,
          entryDate: entry_date,
          sourceModule: 'purchases',
          sourceId: purchaseId,
          description: `فاتورة شراء #${purchaseId} — ${party}`,
          userId
        });
      }
      await client.query(
        `INSERT INTO purchase_lines (purchase_id, is_asset, item_id, item_name, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [purchaseId, line.is_asset, itemId, line.item_name, line.quantity, line.unit_price, line.line_total]
      );
    }

    await client.query(
      `UPDATE treasury_ledger SET entry_date=$1, amount=$2, description=$3
       WHERE source_module = 'purchases' AND source_id = $4`,
      [entry_date, amount, `المشتريات — ${party} (${PAYMENT_LABELS[method]})`, purchaseId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.redirect('/purchases');
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  const existing = await pool.query(`SELECT entry_date FROM purchases WHERE id = $1`, [req.params.id]);
  if (!existing.rows.length) return res.redirect('/purchases');
  if (await isPeriodClosed(existing.rows[0].entry_date)) {
    return res.redirect('/purchases?error=closed');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await reverseMovementsForSource(client, 'purchases', req.params.id);
    await client.query(`DELETE FROM treasury_ledger WHERE source_module = 'purchases' AND source_id = $1`, [req.params.id]);
    await client.query(`DELETE FROM purchases WHERE id = $1`, [req.params.id]); // بنود الفاتورة بتحذف تلقائي (CASCADE)
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.redirect('/purchases');
}));

module.exports = router;
