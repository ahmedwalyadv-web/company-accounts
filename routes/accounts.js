const express = require('express');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(requirePermission('accounts'));

async function buildTree() {
  const result = await pool.query('SELECT * FROM accounts ORDER BY name');
  const byId = {};
  result.rows.forEach(a => { byId[a.id] = { ...a, children: [] }; });
  const roots = [];
  result.rows.forEach(a => {
    if (a.parent_id && byId[a.parent_id]) {
      byId[a.parent_id].children.push(byId[a.id]);
    } else {
      roots.push(byId[a.id]);
    }
  });
  return roots;
}

router.get('/', async (req, res) => {
  const tree = await buildTree();
  const all = await pool.query('SELECT * FROM accounts ORDER BY name');
  res.render('accounts', { title: 'شجرة الحسابات', tree, allAccounts: all.rows });
});

router.post('/', async (req, res) => {
  const { name, type, parent_id, code } = req.body;
  await pool.query(
    'INSERT INTO accounts (name, type, parent_id, code) VALUES ($1,$2,$3,$4)',
    [name, type || 'other', parent_id || null, code || null]
  );
  res.redirect('/accounts');
});

router.post('/:id/delete', async (req, res) => {
  try {
    await pool.query('DELETE FROM accounts WHERE id = $1', [req.params.id]);
  } catch (e) {
    // فيه بيانات مرتبطة بالحساب ده، منقدرش نمسحه
  }
  res.redirect('/accounts');
});

module.exports = router;
