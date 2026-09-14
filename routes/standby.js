const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateAdminOrPartner } = require('../middleware/auth');

router.get('/api/standby', authenticateAdminOrPartner, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT sc.*,
         COALESCE(sc.pilot_name, u.first_name) AS monitor_name,
         CASE WHEN sc.slot_id IS NOT NULL AND sc.booked_date IS NOT NULL THEN (
           SELECT json_agg(json_build_object(
             'flight_type', COALESCE(ft2.name, sc.flight_type),
             'monitor', u2.first_name
           ) ORDER BY s2.start_time)
           FROM slots s2
           LEFT JOIN flight_types ft2 ON s2.flight_type_id::text = ft2.id::text
           LEFT JOIN users u2 ON s2.monitor_id::text = u2.id::text
           WHERE s2.start_time::date = sc.booked_date::date
             AND (s2.title = sc.name OR s2.title LIKE 'Passager % (' || sc.name || ')')
         ) END AS related_flights
       FROM standby_clients sc
       LEFT JOIN slots s ON sc.slot_id = s.id
       LEFT JOIN users u ON s.monitor_id::text = u.id::text
       ORDER BY
         CASE sc.status WHEN 'done' THEN 2 WHEN 'scheduled' THEN 1 ELSE 0 END,
         CASE WHEN sc.availability_start IS NOT NULL THEN sc.availability_start ELSE sc.created_at::date END ASC,
         sc.created_at ASC`
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/api/standby', authenticateAdminOrPartner, async (req, res) => {
  const { name, phone, email, nb_passengers, flight_type, weight_info, availability_text, availability_start, availability_end, notes, source } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO standby_clients (name, phone, email, nb_passengers, flight_type, weight_info, availability_text, availability_start, availability_end, notes, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) RETURNING *`,
      [name||null, phone||null, email||null, nb_passengers||1, flight_type||null, weight_info||null, availability_text||null,
       availability_start||null, availability_end||null, notes||null, source||null]
    );
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/api/standby/free-monitors', authenticateAdminOrPartner, async (req, res) => {
  const { date, time } = req.query;
  if (!date || !time) return res.json([]);
  try {
    const result = await pool.query(
      `SELECT u.id, u.first_name, s.id AS slot_id
       FROM slots s
       JOIN users u ON s.monitor_id::text = u.id::text
       WHERE start_time::date = $1
         AND to_char(s.start_time, 'HH24:MI') = $2
         AND s.status = 'available'
         AND u.is_active_monitor = true
       ORDER BY u.first_name`,
      [date, time]
    );
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/api/standby/by-slot-ids', authenticateAdminOrPartner, async (req, res) => {
  const ids = (req.query.ids || '').split(',').map(Number).filter(n => n > 0);
  if (ids.length === 0) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT id, name, phone, status FROM standby_clients WHERE slot_id = ANY($1)`,
      [ids]
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/api/standby/new-count', authenticateAdminOrPartner, async (req, res) => {
  const { since } = req.query;
  try {
    const ts = since ? new Date(since) : new Date(0);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM standby_clients WHERE created_at > $1`,
      [ts]
    );
    res.json({ count: rows[0].count });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.put('/api/standby/:id', authenticateAdminOrPartner, async (req, res) => {
  const { name, phone, email, nb_passengers, flight_type, weight_info, availability_text, availability_start, availability_end, notes, pilot_name, booked_date, booked_time, slot_id, status } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE standby_clients SET
        name=$1, phone=$2, email=$3, nb_passengers=$4, flight_type=$5, weight_info=$6,
        availability_text=$7, availability_start=$8, availability_end=$9, notes=$10,
        pilot_name=$11, booked_date=$12, booked_time=$13, slot_id=$14, status=$15,
        updated_at=NOW()
       WHERE id=$16 RETURNING *`,
      [name||null, phone||null, email||null, nb_passengers||1, flight_type||null, weight_info||null,
       availability_text||null, availability_start||null, availability_end||null, notes||null,
       pilot_name||null, booked_date||null, booked_time||null, slot_id||null, status||'pending',
       req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Introuvable' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.patch('/api/standby/:id', authenticateAdminOrPartner, async (req, res) => {
  const allowed = ['status', 'slot_id', 'booked_date', 'booked_time', 'pilot_name', 'processing_by', 'source'];
  const updates = Object.keys(req.body).filter(k => allowed.includes(k));
  if (updates.length === 0) return res.status(400).json({ error: 'Aucun champ valide' });
  const set = updates.map((k, i) => `${k}=$${i + 1}`).join(', ');
  const vals = [...updates.map(k => req.body[k] ?? null), req.params.id];
  try {
    const { rows } = await pool.query(
      `UPDATE standby_clients SET ${set}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Introuvable' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.delete('/api/standby/:id', authenticateAdminOrPartner, async (req, res) => {
  try {
    await pool.query('DELETE FROM standby_clients WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

module.exports = router;
