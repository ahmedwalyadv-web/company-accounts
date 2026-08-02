const express = require('express');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { findOrCreateItem, applyStockMovement } = require('../db/inventory');

const router = express.Router();
router.use(requirePermission('inventory'));

router.get('/', asyncHandler(async (req, res) => {
  const items = await pool.query('SELECT * FROM items ORDER BY name');
  const totalValue = items.rows.reduce((sum, i) => sum + Number(i.quantity_on_hand) * Number(i.unit_cost), 0);
  const movements = await pool.query(`
    SELECT m.*, i.name AS item_name, u.full_name AS created_by_name
    FROM inventory_movements m
    JOIN items i ON m.item_id = i.id
    LEFT JOIN users u ON m.created_by = u.id
    ORDER BY m.entry_date DESC, m.id DESC LIMIT 200
  `);
  res.render('inventory', {
    title: 'المخزون',
    items: items.rows,
    totalValue,
    movements: movements.rows,
    error: null
  });
}));

// تسوية يدوية للمخزون (رصيد افتتاحي، تلف، عجز... إلخ)
router.post('/adjust', asyncHandler(async (req, res) => {
  const { item_name, direction, quantity, unit_cost, entry_date, description } = req.body;
  if (!item_name || !item_name.trim() || !quantity || isNaN(Number(quantity)) || Number(quantity) <= 0) {
    const items = await pool.query('SELECT * FROM items ORDER BY name');
    const totalValue = items.rows.reduce((sum, i) => sum + Number(i.quantity_on_hand) * Number(i.unit_cost), 0);
    const movements = await pool.query(`
      SELECT m.*, i.name AS item_name, u.full_name AS created_by_name
      FROM inventory_movements m JOIN items i ON m.item_id = i.id LEFT JOIN users u ON m.created_by = u.id
      ORDER BY m.entry_date DESC, m.id DESC LIMIT 200
    `);
    return res.render('inventory', {
      title: 'المخزون', items: items.rows, totalValue, movements: movements.rows,
      error: 'برجاء اختيار اسم الصنف والكمية بشكل صحيح'
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const item = await findOrCreateItem(client, item_name);
    await applyStockMovement(client, {
      itemId: item.id,
      quantity: Number(quantity),
      direction: direction === 'out' ? 'out' : 'in',
      unitCost: unit_cost !== undefined && unit_cost !== '' ? Number(unit_cost) : null,
      entryDate: entry_date || new Date().toISOString().slice(0, 10),
      sourceModule: 'adjustment',
      description: description || 'تسوية مخزون يدوية',
      userId: req.session.user.id
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.redirect('/inventory');
}));

module.exports = router;
