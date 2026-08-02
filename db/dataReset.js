// أدوات مسح البيانات (كامل أو جزئي) — بتستخدم من صفحة الإعدادات (أدمن فقط)
// كل دالة مسح بتحافظ على تناسق البيانات: بتعكس حركات المخزون المرتبطة، أو تفك الربط
// (بدل ما تكسر قيود قاعدة البيانات) قبل الحذف الفعلي.
const { reverseMovementsForSource } = require('./inventory');

const MODULE_LABELS = {
  purchases: 'المشتريات',
  sales: 'المبيعات',
  expenses: 'المصروفات',
  receipts: 'استلام الفلوس',
  customers: 'العملاء',
  suppliers: 'الموردين',
  inventory: 'المخزون',
  closings: 'التقفيل الشهري وتسوية الخزنة'
};

async function clearPurchases(client) {
  const ids = (await client.query('SELECT id FROM purchases')).rows.map(r => r.id);
  for (const id of ids) {
    await reverseMovementsForSource(client, 'purchases', id);
  }
  await client.query(`DELETE FROM treasury_ledger WHERE source_module = 'purchases'`);
  await client.query('DELETE FROM purchases'); // purchase_lines بتتحذف تلقائي (CASCADE)
}

async function clearSales(client) {
  const ids = (await client.query('SELECT id FROM sales')).rows.map(r => r.id);
  for (const id of ids) {
    await reverseMovementsForSource(client, 'sales', id);
  }
  await client.query(`DELETE FROM treasury_ledger WHERE source_module = 'sales'`);
  await client.query('DELETE FROM sales'); // sale_lines بتتحذف تلقائي (CASCADE)
}

async function clearExpenses(client) {
  await client.query(`DELETE FROM treasury_ledger WHERE source_module = 'expenses'`);
  await client.query('DELETE FROM expenses');
}

async function clearReceipts(client) {
  await client.query(`DELETE FROM treasury_ledger WHERE source_module = 'receipts'`);
  await client.query('DELETE FROM receipts');
}

async function clearCustomers(client) {
  await client.query('UPDATE sales SET customer_id = NULL');
  await client.query('DELETE FROM customers');
}

async function clearSuppliers(client) {
  await client.query('UPDATE purchases SET supplier_id = NULL');
  await client.query('DELETE FROM suppliers');
}

async function clearInventory(client) {
  await client.query('UPDATE purchase_lines SET item_id = NULL');
  await client.query('UPDATE sale_lines SET item_id = NULL');
  await client.query('DELETE FROM inventory_movements');
  await client.query('DELETE FROM items');
}

async function clearClosings(client) {
  await client.query(`DELETE FROM treasury_ledger WHERE source_module = 'reconciliation'`);
  await client.query('DELETE FROM treasury_reconciliations');
  await client.query('DELETE FROM monthly_closings');
}

const CLEARERS = {
  purchases: clearPurchases,
  sales: clearSales,
  expenses: clearExpenses,
  receipts: clearReceipts,
  customers: clearCustomers,
  suppliers: clearSuppliers,
  inventory: clearInventory,
  closings: clearClosings
};

// بيمسح مجموعة موديولات محددة، بترتيب آمن (المشتريات/المبيعات الأول عشان يعكسوا حركة المخزون
// بشكل صحيح قبل ما نمسح المخزون نفسه لو كان متحدد كمان)
async function clearModules(client, moduleKeys) {
  const order = ['purchases', 'sales', 'expenses', 'receipts', 'customers', 'suppliers', 'inventory', 'closings'];
  for (const key of order) {
    if (moduleKeys.includes(key) && CLEARERS[key]) {
      await CLEARERS[key](client);
    }
  }
}

// تصفير كامل لكل الحركات (بيسيب اليوزرز/الأدوار/شجرة الحسابات/إعدادات الشركة/أسباب الصرف كما هي)
async function clearAll(client) {
  await client.query(`
    TRUNCATE purchases, purchase_lines, sales, sale_lines,
      expenses, receipts, treasury_ledger,
      inventory_movements, items, customers, suppliers,
      monthly_closings, treasury_reconciliations
    RESTART IDENTITY CASCADE
  `);
}

module.exports = { clearModules, clearAll, MODULE_LABELS };
