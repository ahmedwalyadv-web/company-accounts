const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireGuest } = require('../middleware/auth');

const router = express.Router();

router.get('/login', requireGuest, (req, res) => {
  res.render('login', { title: 'تسجيل الدخول', error: null });
});

router.post('/login', requireGuest, async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query(
      `SELECT u.*, r.name AS role_name, r.is_admin, r.permissions
       FROM users u JOIN roles r ON u.role_id = r.id
       WHERE u.username = $1`,
      [username]
    );
    const user = result.rows[0];
    if (!user || !user.active) {
      return res.render('login', { title: 'تسجيل الدخول', error: 'اسم المستخدم غير موجود أو الحساب معطل' });
    }
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.render('login', { title: 'تسجيل الدخول', error: 'كلمة المرور غير صحيحة' });
    }
    req.session.user = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role_name: user.role_name,
      is_admin: user.is_admin,
      permissions: user.permissions || []
    };
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('login', { title: 'تسجيل الدخول', error: 'حصل خطأ، حاول تاني' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/change-password', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('change-password', { title: 'تغيير كلمة المرور', error: null, success: null });
});

router.post('/change-password', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { current_password, new_password } = req.body;
  try {
    const result = await pool.query(`SELECT * FROM users WHERE id = $1`, [req.session.user.id]);
    const user = result.rows[0];
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) {
      return res.render('change-password', { title: 'تغيير كلمة المرور', error: 'كلمة المرور الحالية غير صحيحة', success: null });
    }
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, user.id]);
    res.render('change-password', { title: 'تغيير كلمة المرور', error: null, success: 'تم تغيير كلمة المرور بنجاح' });
  } catch (err) {
    console.error(err);
    res.render('change-password', { title: 'تغيير كلمة المرور', error: 'حصل خطأ', success: null });
  }
});

module.exports = router;
