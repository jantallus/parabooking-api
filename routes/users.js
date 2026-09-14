const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../db');
const { pool } = db;
const { authenticateUser, authenticateAdmin, authenticateAdminOrPartner } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { CreateUserSchema, UpdateUserSchema } = require('../schemas');

router.get('/api/users', authenticateAdminOrPartner, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, first_name, email, phone, role, enseigne, is_active_monitor, google_sync_enabled, receives_online_payments, commission_type, commission_value, status, notify_on_request, request_notification_sms FROM users ORDER BY first_name ASC');
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/api/users', authenticateAdminOrPartner, validate(CreateUserSchema), async (req, res) => {
  const { first_name, email, phone, password, role, enseigne, is_active_monitor, google_sync_enabled, receives_online_payments, commission_type, commission_value, available_start_date, available_end_date, daily_start_time, daily_end_time, notify_on_request, request_notification_sms } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO users (first_name, email, phone, password_hash, role, enseigne, is_active_monitor, google_sync_enabled, receives_online_payments, commission_type, commission_value, status, available_start_date, available_end_date, daily_start_time, daily_end_time, notify_on_request, request_notification_sms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'Actif', $12, $13, $14, $15, $16, $17) RETURNING id, first_name, role, enseigne`,
      [first_name, email, phone || null, hash, role, enseigne || 'fluide', is_active_monitor, google_sync_enabled ?? false, receives_online_payments ?? false, commission_type || 'none', commission_value || 0, available_start_date || null, available_end_date || null, daily_start_time || null, daily_end_time || null, notify_on_request ?? false, request_notification_sms || null]
    );
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.patch('/api/users/:id', authenticateUser, validate(UpdateUserSchema), async (req, res) => {
  const { first_name, email, phone, role, enseigne, is_active_monitor, google_sync_enabled, receives_online_payments, commission_type, commission_value, status, password, available_start_date, available_end_date, daily_start_time, daily_end_time, notify_on_request, request_notification_sms } = req.body;
  try {
    if (!['admin', 'aravis'].includes(req.user.role) && req.user.id !== parseInt(req.params.id)) {
      return res.status(403).json({ error: "Interdit : Vous ne pouvez modifier que votre propre profil." });
    }

    let finalRole = role;
    let finalEnseigne = enseigne;
    let finalActive = is_active_monitor;
    let finalGoogleSync = google_sync_enabled;
    let finalOnline = receives_online_payments;
    let finalCommType = commission_type;
    let finalCommValue = commission_value;
    let finalStatus = status;
    if (!['admin', 'aravis'].includes(req.user.role)) {
      const check = await pool.query('SELECT role, enseigne, is_active_monitor, google_sync_enabled, receives_online_payments, commission_type, commission_value, status FROM users WHERE id=$1', [req.params.id]);
      finalRole = check.rows[0].role;
      finalEnseigne = check.rows[0].enseigne;
      finalActive = check.rows[0].is_active_monitor;
      finalGoogleSync = check.rows[0].google_sync_enabled;
      finalOnline = check.rows[0].receives_online_payments;
      finalCommType = check.rows[0].commission_type;
      finalCommValue = check.rows[0].commission_value;
      finalStatus = check.rows[0].status;
    }

    const startD = available_start_date || null;
    const endD = available_end_date || null;
    const startT = daily_start_time || null;
    const endT = daily_end_time || null;

    // Un seul pilote peut recevoir les paiements en ligne
    if (finalOnline === true) {
      await pool.query('UPDATE users SET receives_online_payments = false WHERE id != $1', [req.params.id]);
    }

    if (password) {
       const hash = await bcrypt.hash(password, 10);
       await pool.query(
         'UPDATE users SET first_name=$1, email=$2, phone=$3, role=$4, enseigne=$5, is_active_monitor=$6, google_sync_enabled=$7, receives_online_payments=$8, commission_type=$9, commission_value=$10, status=$11, password_hash=$12, available_start_date=$13, available_end_date=$14, daily_start_time=$15, daily_end_time=$16, notify_on_request=$17, request_notification_sms=$18 WHERE id=$19',
         [first_name, email, phone || null, finalRole, finalEnseigne || 'fluide', finalActive, finalGoogleSync, finalOnline, finalCommType || 'none', finalCommValue ?? 0, finalStatus, hash, startD, endD, startT, endT, notify_on_request ?? false, request_notification_sms || null, req.params.id]
       );
    } else {
       await pool.query(
         'UPDATE users SET first_name=$1, email=$2, phone=$3, role=$4, enseigne=$5, is_active_monitor=$6, google_sync_enabled=$7, receives_online_payments=$8, commission_type=$9, commission_value=$10, status=$11, available_start_date=$12, available_end_date=$13, daily_start_time=$14, daily_end_time=$15, notify_on_request=$16, request_notification_sms=$17 WHERE id=$18',
         [first_name, email, phone || null, finalRole, finalEnseigne || 'fluide', finalActive, finalGoogleSync, finalOnline, finalCommType || 'none', finalCommValue ?? 0, finalStatus, startD, endD, startT, endT, notify_on_request ?? false, request_notification_sms || null, req.params.id]
       );
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(409).json({ error: 'Cet email est déjà utilisé par un autre compte.' });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/api/users/:id', authenticateAdminOrPartner, async (req, res) => {
  try {
    if (req.user && req.user.id === req.params.id) return res.status(400).json({ error: "Interdit de supprimer son propre compte." });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/api/users/:id/availabilities', authenticateUser, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, user_id, created_at, TO_CHAR(start_date, \'YYYY-MM-DD\') as start_date, TO_CHAR(end_date, \'YYYY-MM-DD\') as end_date, daily_start_time, daily_end_time FROM monitor_availabilities WHERE user_id = $1 ORDER BY start_date ASC', [req.params.id]);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.put('/api/users/:id/availabilities', authenticateUser, async (req, res) => {
  const { availabilities } = req.body; 
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM monitor_availabilities WHERE user_id = $1', [req.params.id]);
    for (const a of availabilities) {
      await client.query(
        'INSERT INTO monitor_availabilities (user_id, start_date, end_date, daily_start_time, daily_end_time) VALUES ($1, $2, $3, $4, $5)',
        [req.params.id, a.start_date, a.end_date, a.daily_start_time || '00:00', a.daily_end_time || '23:59']
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

router.post('/api/pilots/check-availability', authenticateUser, async (req, res) => {
  const { startDate, endDate } = req.body;
  if (!startDate || !endDate) return res.status(400).json({ error: 'startDate et endDate requis' });
  try {
    const pilotsRes = await pool.query(
      `SELECT id, first_name AS name FROM users WHERE is_active_monitor = true AND status = 'Actif' ORDER BY first_name ASC`
    );
    // Indisponibilités chevauchant la période demandée
    const unavailsRes = await pool.query(
      `SELECT user_id FROM monitor_availabilities WHERE start_date <= $2 AND end_date >= $1`,
      [startDate, endDate]
    );
    const pilotsWithUnavail = new Set(unavailsRes.rows.map(r => String(r.user_id)));

    const pilots = pilotsRes.rows.map(p => ({
      id: String(p.id),
      name: p.name,
      hasUnavailability: pilotsWithUnavail.has(String(p.id)),
    }));

    res.json({ pilots });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/api/pilots/bulk-add-availability', authenticateUser, async (req, res) => {
  const { pilotIds, startDate, endDate } = req.body;
  if (!pilotIds?.length || !startDate || !endDate) return res.status(400).json({ error: 'Paramètres manquants' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of pilotIds) {
      await client.query(
        'INSERT INTO monitor_availabilities (user_id, start_date, end_date, daily_start_time, daily_end_time) VALUES ($1, $2, $3, $4, $5)',
        [id, startDate, endDate, '00:00', '23:59']
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, count: pilotIds.length });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

router.get('/api/monitors-admin', authenticateUser, async (req, res) => {
  try {
    let query = `
      SELECT id, first_name, email, phone, role, is_active_monitor, status,
             google_sync_enabled, receives_online_payments,
             commission_type, commission_value,
             TO_CHAR(available_start_date, 'YYYY-MM-DD') as available_start_date,
             TO_CHAR(available_end_date, 'YYYY-MM-DD') as available_end_date,
             daily_start_time, daily_end_time
      FROM users
      WHERE LOWER(role) IN ('admin', 'permanent', 'monitor', 'aravis', 'aravis_admin')
    `;
    let params = [];

    query += ` ORDER BY CASE WHEN role = 'admin' THEN 1 WHEN role = 'permanent' THEN 2 WHEN role IN ('aravis', 'aravis_admin') THEN 3 ELSE 4 END, first_name ASC`;
    
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/api/monitors', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, first_name FROM users
      WHERE is_active_monitor = true AND status = 'Actif' AND LOWER(role) IN ('admin', 'permanent', 'monitor', 'aravis', 'aravis_admin')
      ORDER BY first_name ASC
    `);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});


module.exports = router;
