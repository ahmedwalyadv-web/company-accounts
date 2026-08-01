const express = require('express');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const { MODULES } = require('../config/permissions');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requirePermission('roles'));

router.get('/', asyncHandler(async (req, res) => {
  const roles = await pool.query('SELECT * FROM roles ORDER BY id');
  res.render('roles', { title: 'الأدوار والصلاحيات', roles: roles.rows, MODULES, error: null });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name } = req.body;
  let permissions = req.body.permissions || [];
  if (!Array.isArray(permissions)) permissions = [permissions];
  try {
    await pool.query('INSERT INTO roles (name, permissions) VALUES ($1,$2)', [name, permissions]);
    res.redirect('/roles');
  } catch (err) {
    const roles = await pool.query('SELECT * FROM roles ORDER BY id');
    res.render('roles', { title: 'الأدوار والصلاحيات', roles: roles.rows, MODULES, error: 'اسم الدور موجود بالفعل' });
  }
}));

router.post('/:id', asyncHandler(async (req, res) => {
  const role = await pool.query('SELECT * FROM roles WHERE id = $1', [req.params.id]);
  if (role.rows[0] && role.rows[0].is_admin) {
    // دور المدير الكامل ثابت وليه كل الصلاحيات دايمًا
    return res.redirect('/roles');
  }
  let permissions = req.body.permissions || [];
  if (!Array.isArray(permissions)) permissions = [permissions];
  await pool.query('UPDATE roles SET permissions = $1 WHERE id = $2', [permissions, req.params.id]);
  res.redirect('/roles');
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  const role = await pool.query('SELECT * FROM roles WHERE id = $1', [req.params.id]);
  if (role.rows[0] && role.rows[0].is_admin) {
    return res.redirect('/roles');
  }
  try {
    await pool.query('DELETE FROM roles WHERE id = $1', [req.params.id]);
  } catch (e) {
    // فيه يوزرز مرتبطين بالدور ده
  }
  res.redirect('/roles');
}));

module.exports = router;
