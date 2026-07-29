function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireGuest(req, res, next) {
  if (req.session.user) {
    return res.redirect('/');
  }
  next();
}

// middleware factory: يتأكد إن اليوزر عنده صلاحية موديول معين
function requirePermission(moduleKey) {
  return (req, res, next) => {
    const user = req.session.user;
    if (!user) return res.redirect('/login');
    if (user.is_admin || user.permissions.includes(moduleKey)) {
      return next();
    }
    return res.status(403).render('403', { title: 'غير مصرح' });
  };
}

module.exports = { requireLogin, requireGuest, requirePermission };
