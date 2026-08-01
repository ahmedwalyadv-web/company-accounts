const express = require('express');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const { isPeriodClosed } = require('../db/periodLock');
const asyncHandler = require('../middleware/asyncHandler');

// factory بيبني راوتر جاهز لأي موديول من الأربعة: مشتريات / مصروفات / مبيعات / استلام فلوس
// كلهم بنفس الشكل: تاريخ + طرف (مورد/مستلم/عميل/دافع) + سبب + مبلغ + وصف
// وكل عملية بتتسجل تلقائيًا كحركة في الخزنة (treasury_ledger)
// أي شهر اتعمله تقفيل شهري بيبقى مقفول: مينفعش تضيف/تعدل/تحذف حركة تاريخها جوه شهر مقفول
function createTransactionRouter({ table, moduleKey, direction, pageTitle, partyLabel, useReasonDropdown }) {
  const router = express.Router();
  router.use(requirePermission(moduleKey));

  router.get('/', asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT t.*, u.full_name AS created_by_name, a.name AS account_name
       FROM ${table} t
       LEFT JOIN users u ON t.created_by = u.id
       LEFT JOIN accounts a ON t.account_id = a.id
       ORDER BY t.entry_date DESC, t.id DESC LIMIT 300`
    );
    const totalResult = await pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM ${table}`);
    res.render('transactions/list', {
      title: pageTitle,
      pageTitle,
      moduleKey,
      partyLabel,
      rows: result.rows,
      total: totalResult.rows[0].total,
      error: req.query.error === 'closed'
        ? 'الشهر ده مقفول (تم عمل تقفيل شهري ليه)، مينفعش تضيف أو تعدل أو تحذف حركات فيه. لو محتاج تعدل، لازم الأدمن يفتح الشهر تاني من صفحة التقفيل الشهري.'
        : (req.query.error === 'invalid' ? 'البيانات المدخلة ناقصة أو غير صحيحة، برجاء المحاولة تاني.' : null)
    });
  }));

  router.get('/new', asyncHandler(async (req, res) => {
    const accounts = (await pool.query(`SELECT * FROM accounts ORDER BY name`)).rows;
    let reasons = [];
    if (useReasonDropdown) {
      const r = await pool.query(`SELECT * FROM expense_reasons WHERE active = true ORDER BY name`);
      reasons = r.rows;
    }
    res.render('transactions/form', {
      title: 'إضافة حركة — ' + pageTitle,
      pageTitle,
      moduleKey,
      partyLabel,
      useReasonDropdown,
      reasons,
      accounts,
      row: null,
      today: new Date().toISOString().slice(0, 10)
    });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const { entry_date, party, reason, amount, account_id, description } = req.body;

    // تحقق أساسي: التاريخ والطرف والمبلغ لازم يكونوا موجودين وصحيحين
    if (!entry_date || !party || amount === undefined || amount === '' || isNaN(Number(amount))) {
      return res.redirect('/' + moduleKey + '?error=invalid');
    }
    if (await isPeriodClosed(entry_date)) {
      return res.redirect('/' + moduleKey + '?error=closed');
    }

    const userId = req.session.user.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO ${table} (entry_date, party, reason, amount, account_id, description, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [entry_date, party, reason || null, amount, account_id || null, description || null, userId]
      );
      await client.query(
        `INSERT INTO treasury_ledger (entry_date, direction, amount, source_module, source_id, description, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [entry_date, direction, amount, moduleKey, inserted.rows[0].id, `${pageTitle} — ${party}`, userId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.redirect('/' + moduleKey);
  }));

  router.get('/:id/edit', asyncHandler(async (req, res) => {
    const result = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) return res.redirect('/' + moduleKey);
    if (await isPeriodClosed(result.rows[0].entry_date)) {
      return res.redirect('/' + moduleKey + '?error=closed');
    }
    const accounts = (await pool.query(`SELECT * FROM accounts ORDER BY name`)).rows;
    let reasons = [];
    if (useReasonDropdown) {
      const r = await pool.query(`SELECT * FROM expense_reasons WHERE active = true ORDER BY name`);
      reasons = r.rows;
    }
    res.render('transactions/form', {
      title: 'تعديل حركة — ' + pageTitle,
      pageTitle,
      moduleKey,
      partyLabel,
      useReasonDropdown,
      reasons,
      accounts,
      row: result.rows[0],
      today: new Date().toISOString().slice(0, 10)
    });
  }));

  router.post('/:id', asyncHandler(async (req, res) => {
    const { entry_date, party, reason, amount, account_id, description } = req.body;

    if (!entry_date || !party || amount === undefined || amount === '' || isNaN(Number(amount))) {
      return res.redirect('/' + moduleKey + '?error=invalid');
    }

    const existing = await pool.query(`SELECT entry_date FROM ${table} WHERE id = $1`, [req.params.id]);
    if (!existing.rows.length) return res.redirect('/' + moduleKey);
    if ((await isPeriodClosed(existing.rows[0].entry_date)) || (await isPeriodClosed(entry_date))) {
      return res.redirect('/' + moduleKey + '?error=closed');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ${table} SET entry_date=$1, party=$2, reason=$3, amount=$4, account_id=$5, description=$6 WHERE id=$7`,
        [entry_date, party, reason || null, amount, account_id || null, description || null, req.params.id]
      );
      await client.query(
        `UPDATE treasury_ledger SET entry_date=$1, amount=$2, description=$3
         WHERE source_module = $4 AND source_id = $5`,
        [entry_date, amount, `${pageTitle} — ${party}`, moduleKey, req.params.id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.redirect('/' + moduleKey);
  }));

  router.post('/:id/delete', asyncHandler(async (req, res) => {
    const existing = await pool.query(`SELECT entry_date FROM ${table} WHERE id = $1`, [req.params.id]);
    if (!existing.rows.length) return res.redirect('/' + moduleKey);
    if (await isPeriodClosed(existing.rows[0].entry_date)) {
      return res.redirect('/' + moduleKey + '?error=closed');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM treasury_ledger WHERE source_module = $1 AND source_id = $2`, [moduleKey, req.params.id]);
      await client.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.redirect('/' + moduleKey);
  }));

  return router;
}

module.exports = createTransactionRouter;
