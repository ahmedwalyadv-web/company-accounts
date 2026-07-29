require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const pool = require('./db/pool');
const { MODULES } = require('./config/permissions');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: false }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // أسبوع
}));

// إتاحة بيانات اليوزر + إعدادات الشركة لكل الـ views
app.use(async (req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.MODULES = MODULES;
  try {
    const result = await pool.query('SELECT * FROM company_settings WHERE id = 1');
    res.locals.company = result.rows[0] || { name: 'اسم الشركة', logo_data: null, currency: 'ج.م' };
  } catch (e) {
    res.locals.company = { name: 'اسم الشركة', logo_data: null, currency: 'ج.م' };
  }
  next();
});

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/accounts', require('./routes/accounts'));
app.use('/treasury', require('./routes/treasury'));
app.use('/purchases', require('./routes/purchases'));
app.use('/expenses', require('./routes/expenses'));
app.use('/sales', require('./routes/sales'));
app.use('/receipts', require('./routes/receipts'));
app.use('/users', require('./routes/users'));
app.use('/roles', require('./routes/roles'));
app.use('/settings', require('./routes/settings'));

app.use((req, res) => {
  res.status(404).render('404', { title: 'الصفحة غير موجودة' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('حصل خطأ في السيرفر: ' + err.message);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ السيرفر شغال على http://localhost:${PORT}`);
});
