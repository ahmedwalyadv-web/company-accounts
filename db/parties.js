// أدوات مشتركة لإيجاد أو إنشاء "طرف" (عميل أو مورد) تلقائيًا بالاسم بس،
// من غير ما يكون لازم المستخدم يضيفه مسبقًا من صفحة العملاء/الموردين.
// لو لقى طرف بنفس الاسم موجود، بيرجعه (وبيكمل بياناته بالتليفون/الإيميل لو كانت فاضية وجت قيمة جديدة).
// لو مش موجود، بيعمله سجل جديد.
async function findOrCreateParty(client, table, { name, phone, email, address }) {
  const cleanName = (name || '').trim();
  if (!cleanName) return null;

  const existing = await client.query(
    `SELECT * FROM ${table} WHERE lower(name) = lower($1) LIMIT 1`,
    [cleanName]
  );

  if (existing.rows.length) {
    const row = existing.rows[0];
    const updates = [];
    const values = [];
    let i = 1;
    if (!row.phone && phone) { updates.push(`phone = $${i++}`); values.push(phone); }
    if (!row.email && email) { updates.push(`email = $${i++}`); values.push(email); }
    if (!row.address && address) { updates.push(`address = $${i++}`); values.push(address); }
    if (updates.length) {
      values.push(row.id);
      const updated = await client.query(
        `UPDATE ${table} SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
        values
      );
      return updated.rows[0];
    }
    return row;
  }

  const inserted = await client.query(
    `INSERT INTO ${table} (name, phone, email, address) VALUES ($1,$2,$3,$4) RETURNING *`,
    [cleanName, phone || null, email || null, address || null]
  );
  return inserted.rows[0];
}

function findOrCreateCustomer(client, data) {
  return findOrCreateParty(client, 'customers', data);
}

function findOrCreateSupplier(client, data) {
  return findOrCreateParty(client, 'suppliers', data);
}

module.exports = { findOrCreateCustomer, findOrCreateSupplier };
