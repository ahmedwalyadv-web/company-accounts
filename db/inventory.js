// أدوات مشتركة للتعامل مع المخزون (بتستخدم جوه ترانزاكشن من المشتريات/المبيعات/التسوية اليدوية)

// بيجيب صنف موجود بالاسم، أو ينشئه لو غير موجود، ويرجع صف الصنف
async function findOrCreateItem(client, itemName) {
  const name = itemName.trim();
  const existing = await client.query('SELECT * FROM items WHERE name = $1', [name]);
  if (existing.rows.length) return existing.rows[0];
  const inserted = await client.query(
    'INSERT INTO items (name, unit_cost, quantity_on_hand) VALUES ($1, 0, 0) RETURNING *',
    [name]
  );
  return inserted.rows[0];
}

// بيسجل حركة مخزون (وارد/منصرف) وبيحدث الكمية (والتكلفة لو وارد بتكلفة معروفة)
// بيرجع true لو نجح، أو بيرمي خطأ لو الكمية المطلوب سحبها أكبر من الموجود (منصرف) ومفيش سماح بالسالب
async function applyStockMovement(client, {
  itemId, quantity, direction, unitCost, entryDate,
  sourceModule, sourceId, description, userId, allowNegative = true
}) {
  const item = await client.query('SELECT * FROM items WHERE id = $1 FOR UPDATE', [itemId]);
  if (!item.rows.length) throw new Error('الصنف غير موجود');
  const current = item.rows[0];

  let newQty = Number(current.quantity_on_hand);
  let newCost = Number(current.unit_cost);
  let movementCost; // التكلفة اللي هنسجلها في سجل الحركة (لازمة لعكسها بدقة بعدين)

  if (direction === 'in') {
    const incomingQty = Number(quantity);
    const incomingCost = unitCost !== undefined && unitCost !== null ? Number(unitCost) : newCost;
    const totalOldValue = newQty * newCost;
    const totalNewValue = incomingQty * incomingCost;
    const totalQty = newQty + incomingQty;
    newCost = totalQty > 0 ? (totalOldValue + totalNewValue) / totalQty : incomingCost;
    newQty = totalQty;
    movementCost = incomingCost;
  } else {
    newQty = newQty - Number(quantity);
    if (newQty < 0 && !allowNegative) {
      throw new Error(`الكمية المطلوبة من "${current.name}" أكبر من الموجود في المخزن`);
    }
    movementCost = newCost; // تكلفة المتوسط وقت الصرف (لمعرفة تكلفة البضاعة المباعة تقريبًا)
  }

  await client.query('UPDATE items SET quantity_on_hand = $1, unit_cost = $2 WHERE id = $3', [newQty, newCost, itemId]);
  await client.query(
    `INSERT INTO inventory_movements (item_id, direction, quantity, source_module, source_id, unit_cost, entry_date, description, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [itemId, direction, quantity, sourceModule, sourceId || null, movementCost, entryDate, description || null, userId]
  );
}

// بيعكس كل حركات المخزون المرتبطة بمصدر معين (مثلاً فاتورة شراء أو بيع اتعدلت أو اتحذفت)
// لازم تستخدم قبل حذف/تعديل الفاتورة نفسها، وقبل حذف صفوف بنودها
async function reverseMovementsForSource(client, sourceModule, sourceId) {
  const movements = await client.query(
    'SELECT * FROM inventory_movements WHERE source_module = $1 AND source_id = $2',
    [sourceModule, sourceId]
  );
  for (const m of movements.rows) {
    await reverseOneMovement(client, m);
  }
}

async function reverseOneMovement(client, movement) {
  const item = await client.query('SELECT * FROM items WHERE id = $1 FOR UPDATE', [movement.item_id]);
  if (!item.rows.length) {
    await client.query('DELETE FROM inventory_movements WHERE id = $1', [movement.id]);
    return;
  }
  const current = item.rows[0];
  let newQty = Number(current.quantity_on_hand);
  let newCost = Number(current.unit_cost);
  const qty = Number(movement.quantity);

  if (movement.direction === 'in') {
    // نشيل بالضبط الكمية والقيمة اللي كانت اتضافت وقت الحركة دي
    const cost = movement.unit_cost !== null && movement.unit_cost !== undefined ? Number(movement.unit_cost) : newCost;
    const remainingQty = newQty - qty;
    const remainingValue = (newQty * newCost) - (qty * cost);
    newQty = remainingQty;
    newCost = remainingQty > 0 ? remainingValue / remainingQty : 0;
  } else {
    // كانت منصرف (خصم) - نرجعها تاني بدون تغيير متوسط التكلفة الحالي
    newQty = newQty + qty;
  }
  if (newQty < 0) newQty = 0;

  await client.query('UPDATE items SET quantity_on_hand = $1, unit_cost = $2 WHERE id = $3', [newQty, newCost, movement.item_id]);
  await client.query('DELETE FROM inventory_movements WHERE id = $1', [movement.id]);
}

module.exports = { findOrCreateItem, applyStockMovement, reverseMovementsForSource };
