// قائمة الموديولات (الصلاحيات) المتاحة في النظام
// المفتاح (key) هو اللي بيتخزن في عمود permissions بجدول roles
module.exports = {
  MODULES: [
    { key: 'dashboard', label: 'الرئيسية' },
    { key: 'purchases', label: 'المشتريات' },
    { key: 'expenses', label: 'المصروفات' },
    { key: 'sales', label: 'المبيعات' },
    { key: 'receipts', label: 'استلام الفلوس' },
    { key: 'accounts', label: 'شجرة الحسابات' },
    { key: 'treasury', label: 'الخزنة' },
    { key: 'reports', label: 'التقارير' },
    { key: 'closing', label: 'التقفيل الشهري' },
    { key: 'users', label: 'المستخدمين' },
    { key: 'roles', label: 'الأدوار والصلاحيات' },
    { key: 'settings', label: 'إعدادات الشركة' }
  ]
};
