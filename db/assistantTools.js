// أدوات المساعد الافتراضي: تعريف كل أداة (Tool) ممكن الموديل يطلبها + الكود الفعلي اللي بينفذها
// الأدوات مقسّمة لنوعين:
//  - "قراءة فقط" (readOnly: true): بتنفذ على طول لأنها ما بتغيرش أي بيانات (استعلامات وتقارير)
//  - "كتابة" (readOnly: false): محتاجة تأكيد صريح من المستخدم في الواجهة قبل التنفيذ الفعلي على قاعدة البيانات
const pool = require('./pool');
const { isPeriodClosed } = require('./periodLock');
const { findOrCreateItem, applyStockMovement, reverseMovementsForSource } = require('./inventory');

const TOOLS = [
  {
    name: 'get_treasury_balance',
    readOnly: true,
    description: 'يرجع رصيد الخزنة الحالي (الكاش المتاح فعليًا)',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_inventory_summary',
    readOnly: true,
    description: 'يرجع تقييم المخزون الحالي (رأس المال) وقائمة الأصناف مع الكمية المتاحة لكل صنف',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_financial_summary',
    readOnly: true,
    description: 'يرجع إجمالي المشتريات/المصروفات/المبيعات/استلام الفلوس وصافي الربح في فترة زمنية معينة',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'تاريخ البداية بصيغة YYYY-MM-DD' },
        to: { type: 'string', description: 'تاريخ النهاية بصيغة YYYY-MM-DD' }
      },
      required: ['from', 'to']
    }
  },
  {
    name: 'create_expense',
    readOnly: false,
    description: 'تسجيل مصروف جديد (زي مرتبات أو مصروفات تشغيل). محتاج تأكيد من المستخدم قبل التنفيذ.',
    input_schema: {
      type: 'object',
      properties: {
        entry_date: { type: 'string', description: 'تاريخ الحركة YYYY-MM-DD' },
        party: { type: 'string', description: 'اسم المستلم' },
        reason: { type: 'string', description: 'سبب الصرف، مثلاً: مرتبات، مصروفات تشغيل' },
        amount: { type: 'number' },
        description: { type: 'string' }
      },
      required: ['entry_date', 'party', 'reason', 'amount']
    }
  },
  {
    name: 'create_receipt',
    readOnly: false,
    description: 'تسجيل استلام فلوس جديد. محتاج تأكيد من المستخدم قبل التنفيذ.',
    input_schema: {
      type: 'object',
      properties: {
        entry_date: { type: 'string' },
        party: { type: 'string', description: 'اسم مين دفع الفلوس' },
        reason: { type: 'string' },
        amount: { type: 'number' },
        description: { type: 'string' }
      },
      required: ['entry_date', 'party', 'amount']
    }
  },
  {
    name: 'create_purchase',
    readOnly: false,
    description: 'تسجيل فاتورة شراء جديدة (ممكن تحتوي على أكتر من صنف بكميات مختلفة). الأصناف اللي is_asset=true بتضاف تلقائيًا للمخزون. محتاج تأكيد من المستخدم قبل التنفيذ.',
    input_schema: {
      type: 'object',
      properties: {
        entry_date: { type: 'string' },
        party: { type: 'string', description: 'اسم المورد' },
        payment_method: { type: 'string', enum: ['cash', 'visa', 'network'] },
        description: { type: 'string' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item_name: { type: 'string' },
              is_asset: { type: 'boolean', description: 'true لو الصنف جهاز/أصل هيدخل المخزون' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' }
            },
            required: ['item_name', 'quantity', 'unit_price']
          }
        }
      },
      required: ['entry_date', 'party', 'lines']
    }
  },
  {
    name: 'create_sale',
    readOnly: false,
    description: 'تسجيل فاتورة بيع أو إيجار جديدة. "بيع" بينقص من المخزون، "إيجار" لا. محتاج تأكيد من المستخدم قبل التنفيذ.',
    input_schema: {
      type: 'object',
      properties: {
        entry_date: { type: 'string' },
        party: { type: 'string', description: 'اسم العميل' },
        sale_type: { type: 'string', enum: ['sale', 'rental'] },
        payment_method: { type: 'string', enum: ['cash', 'bank'] },
        bank_account_name: { type: 'string', description: 'اسم الحساب البنكي لو الدفع بحساب بنكي' },
        description: { type: 'string' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item_name: { type: 'string' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' }
            },
            required: ['item_name', 'quantity', 'unit_price']
          }
        }
      },
      required: ['entry_date', 'party', 'sale_type', 'lines']
    }
  }
];

function findTool(name) {
  return TOOLS.find(t => t.name === name);
}

// ---------- تنفيذ أدوات القراءة (بترجع فورًا) ----------

async function execGetTreasuryBalance() {
  const r = await pool.query(`SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS balance FROM treasury_ledger`);
  return { balance: Number(r.rows[0].balance) };
}

async function execGetInventorySummary() {
  const items = await pool.query(`SELECT name, quantity_on_hand, unit_cost FROM items ORDER BY (quantity_on_hand*unit_cost) DESC LIMIT 30`);
  const totalValue = items.rows.reduce((s, i) => s + Number(i.quantity_on_hand) * Number(i.unit_cost), 0);
  return {
    totalValue,
    items: items.rows.map(i => ({ name: i.name, quantity_on_hand: Number(i.quantity_on_hand), unit_cost: Number(i.unit_cost) }))
  };
}

async function execGetFinancialSummary(input) {
  const { from, to } = input;
  const [purchases, expenses, sales, receipts] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM purchases WHERE entry_date BETWEEN $1 AND $2`, [from, to]),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE entry_date BETWEEN $1 AND $2`, [from, to]),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM sales WHERE entry_date BETWEEN $1 AND $2`, [from, to]),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM receipts WHERE entry_date BETWEEN $1 AND $2`, [from, to])
  ]);
  const totalIn = Number(sales.rows[0].total) + Number(receipts.rows[0].total);
  const totalOut = Number(purchases.rows[0].total) + Number(expenses.rows[0].total);
  return {
    from, to,
    purchases: Number(purchases.rows[0].total),
    expenses: Number(expenses.rows[0].total),
    sales: Number(sales.rows[0].total),
    receipts: Number(receipts.rows[0].total),
    netProfit: totalIn - totalOut
  };
}

// ---------- تنفيذ أدوات الكتابة (بعد تأكيد المستخدم فقط) ----------

async function execCreateExpense(input, userId) {
  const { entry_date, party, reason, amount, description } = input;
  if (!entry_date || !party || !reason || !amount || isNaN(Number(amount))) {
    throw new Error('بيانات المصروف ناقصة أو غير صحيحة');
  }
  if (await isPeriodClosed(entry_date)) throw new Error('الشهر ده مقفول، مينفعش تضيف حركات فيه');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO expenses (entry_date, party, reason, amount, description, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [entry_date, party, reason, amount, description || null, userId]
    );
    await client.query(
      `INSERT INTO treasury_ledger (entry_date, direction, amount, source_module, source_id, description, created_by)
       VALUES ($1,'out',$2,'expenses',$3,$4,$5)`,
      [entry_date, amount, inserted.rows[0].id, `المصروفات — ${party} (${reason})`, userId]
    );
    await client.query('COMMIT');
    return { success: true, id: inserted.rows[0].id, message: `تم تسجيل مصروف بقيمة ${amount} لـ ${party} (${reason})` };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function execCreateReceipt(input, userId) {
  const { entry_date, party, reason, amount, description } = input;
  if (!entry_date || !party || !amount || isNaN(Number(amount))) {
    throw new Error('بيانات استلام الفلوس ناقصة أو غير صحيحة');
  }
  if (await isPeriodClosed(entry_date)) throw new Error('الشهر ده مقفول، مينفعش تضيف حركات فيه');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO receipts (entry_date, party, reason, amount, description, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [entry_date, party, reason || null, amount, description || null, userId]
    );
    await client.query(
      `INSERT INTO treasury_ledger (entry_date, direction, amount, source_module, source_id, description, created_by)
       VALUES ($1,'in',$2,'receipts',$3,$4,$5)`,
      [entry_date, amount, inserted.rows[0].id, `استلام فلوس — ${party}`, userId]
    );
    await client.query('COMMIT');
    return { success: true, id: inserted.rows[0].id, message: `تم تسجيل استلام ${amount} من ${party}` };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function cleanLines(lines) {
  return (lines || [])
    .map(l => ({
      item_name: (l.item_name || '').trim(),
      is_asset: !!l.is_asset,
      quantity: Number(l.quantity),
      unit_price: Number(l.unit_price)
    }))
    .filter(l => l.item_name && l.quantity > 0 && !isNaN(l.unit_price) && l.unit_price >= 0);
}

async function execCreatePurchase(input, userId) {
  const { entry_date, party, description } = input;
  const method = ['cash', 'visa', 'network'].includes(input.payment_method) ? input.payment_method : 'cash';
  const lines = cleanLines(input.lines);
  if (!entry_date || !party || !lines.length) throw new Error('بيانات فاتورة الشراء ناقصة، لازم تاريخ ومورد وصنف واحد على الأقل');
  if (await isPeriodClosed(entry_date)) throw new Error('الشهر ده مقفول، مينفعش تضيف حركات فيه');

  const amount = Math.round(lines.reduce((s, l) => s + l.quantity * l.unit_price, 0) * 100) / 100;
  const methodLabels = { cash: 'كاش', visa: 'فيزا', network: 'شبكة' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO purchases (entry_date, party, amount, description, payment_method, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [entry_date, party, amount, description || null, method, userId]
    );
    const purchaseId = inserted.rows[0].id;
    for (const line of lines) {
      let itemId = null;
      const lineTotal = Math.round(line.quantity * line.unit_price * 100) / 100;
      if (line.is_asset) {
        const item = await findOrCreateItem(client, line.item_name);
        itemId = item.id;
        await applyStockMovement(client, {
          itemId, quantity: line.quantity, direction: 'in', unitCost: line.unit_price,
          entryDate: entry_date, sourceModule: 'purchases', sourceId: purchaseId,
          description: `فاتورة شراء #${purchaseId} (عن طريق المساعد الافتراضي) — ${party}`, userId
        });
      }
      await client.query(
        `INSERT INTO purchase_lines (purchase_id, is_asset, item_id, item_name, quantity, unit_price, line_total) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [purchaseId, line.is_asset, itemId, line.item_name, line.quantity, line.unit_price, lineTotal]
      );
    }
    await client.query(
      `INSERT INTO treasury_ledger (entry_date, direction, amount, source_module, source_id, description, created_by) VALUES ($1,'out',$2,'purchases',$3,$4,$5)`,
      [entry_date, amount, purchaseId, `المشتريات — ${party} (${methodLabels[method]})`, userId]
    );
    await client.query('COMMIT');
    return { success: true, id: purchaseId, amount, message: `تم تسجيل فاتورة شراء #${purchaseId} من ${party} بإجمالي ${amount}` };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function execCreateSale(input, userId) {
  const { entry_date, party, description, bank_account_name } = input;
  const type = ['sale', 'rental'].includes(input.sale_type) ? input.sale_type : 'sale';
  const method = ['cash', 'bank'].includes(input.payment_method) ? input.payment_method : 'cash';
  const lines = cleanLines(input.lines);
  if (!entry_date || !party || !lines.length) throw new Error('بيانات فاتورة البيع ناقصة، لازم تاريخ وعميل وصنف واحد على الأقل');
  if (await isPeriodClosed(entry_date)) throw new Error('الشهر ده مقفول، مينفعش تضيف حركات فيه');

  let accountId = null;
  if (method === 'bank') {
    if (!bank_account_name) throw new Error('لازم تحدد اسم الحساب البنكي لو الدفع بحساب بنكي');
    const acc = await pool.query(`SELECT id FROM accounts WHERE name ILIKE $1 LIMIT 1`, [`%${bank_account_name}%`]);
    if (!acc.rows.length) throw new Error(`مفيش حساب بنكي بالاسم "${bank_account_name}" في شجرة الحسابات`);
    accountId = acc.rows[0].id;
  }

  const amount = Math.round(lines.reduce((s, l) => s + l.quantity * l.unit_price, 0) * 100) / 100;
  const methodLabels = { cash: 'كاش', bank: 'حساب بنكي' };
  const typeLabels = { sale: 'بيع', rental: 'إيجار' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO sales (entry_date, party, amount, account_id, description, payment_method, sale_type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [entry_date, party, amount, accountId, description || null, method, type, userId]
    );
    const saleId = inserted.rows[0].id;
    for (const line of lines) {
      const item = await findOrCreateItem(client, line.item_name);
      const lineTotal = Math.round(line.quantity * line.unit_price * 100) / 100;
      if (type === 'sale') {
        await applyStockMovement(client, {
          itemId: item.id, quantity: line.quantity, direction: 'out',
          entryDate: entry_date, sourceModule: 'sales', sourceId: saleId,
          description: `فاتورة بيع #${saleId} (عن طريق المساعد الافتراضي) — ${party}`, userId, allowNegative: true
        });
      }
      await client.query(
        `INSERT INTO sale_lines (sale_id, item_id, item_name, quantity, unit_price, line_total) VALUES ($1,$2,$3,$4,$5,$6)`,
        [saleId, item.id, line.item_name, line.quantity, line.unit_price, lineTotal]
      );
    }
    await client.query(
      `INSERT INTO treasury_ledger (entry_date, direction, amount, source_module, source_id, description, created_by) VALUES ($1,'in',$2,'sales',$3,$4,$5)`,
      [entry_date, amount, saleId, `المبيعات — ${party} (${methodLabels[method]}, ${typeLabels[type]})`, userId]
    );
    await client.query('COMMIT');
    return { success: true, id: saleId, amount, message: `تم تسجيل فاتورة ${typeLabels[type]} #${saleId} لـ ${party} بإجمالي ${amount}` };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// بينفذ أداة قراءة فورًا، أو يرمي خطأ لو الأداة مش من نوع القراءة
async function executeReadOnlyTool(name, input) {
  switch (name) {
    case 'get_treasury_balance': return execGetTreasuryBalance();
    case 'get_inventory_summary': return execGetInventorySummary();
    case 'get_financial_summary': return execGetFinancialSummary(input);
    default: throw new Error('أداة قراءة غير معروفة: ' + name);
  }
}

// بينفذ أداة كتابة فعليًا على قاعدة البيانات (لازم يتنادى بس بعد تأكيد المستخدم)
async function executeWriteTool(name, input, userId) {
  switch (name) {
    case 'create_expense': return execCreateExpense(input, userId);
    case 'create_receipt': return execCreateReceipt(input, userId);
    case 'create_purchase': return execCreatePurchase(input, userId);
    case 'create_sale': return execCreateSale(input, userId);
    default: throw new Error('أداة كتابة غير معروفة: ' + name);
  }
}

// بيبني وصف نصي بسيط بالعربي لطلب الكتابة، عشان نعرضه للمستخدم قبل التأكيد
function describeWriteAction(name, input) {
  switch (name) {
    case 'create_expense':
      return `تسجيل مصروف: ${input.amount} لـ "${input.party}" — السبب: ${input.reason} — بتاريخ ${input.entry_date}`;
    case 'create_receipt':
      return `تسجيل استلام فلوس: ${input.amount} من "${input.party}" — بتاريخ ${input.entry_date}`;
    case 'create_purchase': {
      const lines = cleanLines(input.lines);
      const linesDesc = lines.map(l => `${l.item_name} ×${l.quantity} (${l.unit_price} للوحدة)${l.is_asset ? ' [أصل/جهاز]' : ''}`).join('، ');
      const total = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
      return `تسجيل فاتورة شراء من "${input.party}" بتاريخ ${input.entry_date} — الأصناف: ${linesDesc} — الإجمالي: ${total}`;
    }
    case 'create_sale': {
      const lines = cleanLines(input.lines);
      const linesDesc = lines.map(l => `${l.item_name} ×${l.quantity} (${l.unit_price} للوحدة)`).join('، ');
      const total = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
      const typeLabel = input.sale_type === 'rental' ? 'إيجار' : 'بيع';
      return `تسجيل فاتورة ${typeLabel} لـ "${input.party}" بتاريخ ${input.entry_date} — الأصناف: ${linesDesc} — الإجمالي: ${total}`;
    }
    default:
      return `تنفيذ: ${name}`;
  }
}

module.exports = { TOOLS, findTool, executeReadOnlyTool, executeWriteTool, describeWriteAction };
