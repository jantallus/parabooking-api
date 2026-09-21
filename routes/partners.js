const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateAdmin, authenticateAdminOrPartner, authenticateUser } = require('../middleware/auth');

router.get('/api/partners', authenticateUser, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*,
        COALESCE(
          json_agg(json_build_object('flight_type_id', pft.flight_type_id, 'base_price_cents', pft.base_price_cents))
          FILTER (WHERE pft.flight_type_id IS NOT NULL), '[]'
        ) AS allowed_flight_types
      FROM partners p
      LEFT JOIN partner_flight_types pft ON p.id = pft.partner_id
      GROUP BY p.id
      ORDER BY p.name ASC
    `);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

async function upsertFlightTypes(client, partnerId, allowedFlightTypes) {
  await client.query('DELETE FROM partner_flight_types WHERE partner_id = $1', [partnerId]);
  if (Array.isArray(allowedFlightTypes) && allowedFlightTypes.length > 0) {
    for (const ft of allowedFlightTypes) {
      await client.query(
        'INSERT INTO partner_flight_types (partner_id, flight_type_id, base_price_cents) VALUES ($1, $2, $3)',
        [partnerId, ft.flight_type_id, ft.base_price_cents ?? null]
      );
    }
  }
}

router.post('/api/partners', authenticateAdmin, async (req, res) => {
  const { name, code, color_code, booking_fields, commission_type, commission_value, facturable, default_encaisseur_id, allowed_flight_types } = req.body;
  if (!name?.trim() || !code?.trim()) return res.status(400).json({ error: 'Nom et code requis' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO partners (name, code, color_code, booking_fields, commission_type, commission_value, facturable, default_encaisseur_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name.trim(), code.trim().toUpperCase(), color_code || '#6366f1', JSON.stringify(booking_fields || {}),
       commission_type || 'none', commission_value ?? 0, facturable ?? true, default_encaisseur_id || null]
    );
    await upsertFlightTypes(client, rows[0].id, allowed_flight_types);
    await client.query('COMMIT');
    res.json({ ...rows[0], allowed_flight_types: allowed_flight_types || [] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Ce code existe déjà.' });
    console.error(err); res.status(500).json({ error: 'Erreur serveur' });
  } finally { client.release(); }
});

router.put('/api/partners/:id', authenticateAdmin, async (req, res) => {
  const { name, code, color_code, booking_fields, is_active, commission_type, commission_value, facturable, default_encaisseur_id, allowed_flight_types } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE partners SET name=$1, code=$2, color_code=$3, booking_fields=$4, is_active=$5,
                           commission_type=$6, commission_value=$7, facturable=$8, default_encaisseur_id=$9
       WHERE id=$10 RETURNING *`,
      [name.trim(), code.trim().toUpperCase(), color_code || '#6366f1', JSON.stringify(booking_fields || {}),
       is_active ?? true, commission_type || 'none', commission_value ?? 0, facturable ?? true,
       default_encaisseur_id || null, req.params.id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Partenaire introuvable' }); }
    await upsertFlightTypes(client, rows[0].id, allowed_flight_types);
    await client.query('COMMIT');
    res.json({ ...rows[0], allowed_flight_types: allowed_flight_types || [] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Ce code existe déjà.' });
    console.error(err); res.status(500).json({ error: 'Erreur serveur' });
  } finally { client.release(); }
});

router.delete('/api/partners/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM partners WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

module.exports = router;
