const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(requirePermission('users'));

router.get('/', async (req, res) => {
  const users = await pool.query(`
    SELECT u.*, r.name AS role_name FROM users u
    JOIN roles r ON u.role_id = r.id ORDER BY u.id
  `);
  const roles = await pool.query('SELECT * FROM roles ORDER BY id');
  res.render('users', { title: 'المستخدمين', users: users.rows, roles: roles.rows, error: null });
});

router.post('/', async (req, res) => {
  const { username, password, full_name, role_id } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, full_name, role_id) VALUES ($1,$2,$3,$4)',
      [username, hash, full_name, role_id]
    );
    res.redirect('/users');
  } catch (err) {
    const users = await pool.query(`SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON u.role_id = r.id ORDER BY u.id`);
    const roles = await pool.query('SELECT * FROM roles ORDER BY id');
    res.render('users', { title: 'المستخدمين', users: users.rows, roles: roles.rows, error: 'اسم المستخدم موجود بالفعل أو حصل خطأ' });
  }
});

router.post('/:id/toggle', async (req, res) => {
  await pool.query('UPDATE users SET active = NOT active WHERE id = $1', [req.params.id]);
  res.redirect('/users');
});

router.post('/:id/role', async (req, res) => {
  await pool.query('UPDATE users SET role_id = $1 WHERE id = $2', [req.body.role_id, req.params.id]);
  res.redirect('/users');
});

router.post('/:id/reset-password', async (req, res) => {
  const hash = await bcrypt.hash(req.body.new_password, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
  res.redirect('/users');
});

router.post('/:id/delete', async (req, res) => {
  if (Number(req.params.id) === req.session.user.id) {
    return res.redirect('/users');
  }
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.redirect('/users');
});

module.exports = router;
