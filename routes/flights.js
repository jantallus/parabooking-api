const express = require('express');
const router = express.Router();
const db = require('../db');
const { pool } = db;
const { authenticateUser, authenticateAdmin, authenticateAdminOrPartner } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { FlightTypeSchema } = require('../schemas');

router.get('/api/flight-types', async (req, res) => {
  try {
    const { tenant } = req.query;
    let query, params;
    if (tenant === 'all') {
      query = 'SELECT * FROM flight_types ORDER BY tenant, price_cents ASC';
      params = [];
    } else if (tenant === 'aravis') {
      query = "SELECT * FROM flight_types WHERE tenant = 'aravis' ORDER BY price_cents ASC";
      params = [];
    } else {
      query = "SELECT * FROM flight_types WHERE tenant = 'fluide' ORDER BY price_cents ASC";
      params = [];
    }
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/api/flight-types', authenticateAdminOrPartner, validate(FlightTypeSchema), async (req, res) => {
  const { name, description, activity_ski, activity_snowboard, activity_pedestrian, activity_children, activity_gopro, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots, weight_min, weight_max, booking_delay_hours, image_url, popup_content, show_popup, media_included, passengers_per_slot, tenant, is_giftable, gift_pdf_background_url, gift_custom_line_1, gift_custom_line_2, gift_custom_line_3, gift_validity_months } = req.body;
  const start = restricted_start_time === '' ? null : restricted_start_time;
  const end = restricted_end_time === '' ? null : restricted_end_time;
  const slots = allowed_time_slots ? JSON.stringify(allowed_time_slots) : '[]';
  const flightSeason = season || 'Standard';
  const flightTenant = tenant || req.user.enseigne || (req.user.role === 'aravis' ? 'aravis' : 'fluide');

  try {
    const r = await pool.query(
      `INSERT INTO flight_types (name, description, activity_ski, activity_snowboard, activity_pedestrian, activity_children, activity_gopro, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots, weight_min, weight_max, booking_delay_hours, image_url, popup_content, show_popup, media_included, passengers_per_slot, tenant, is_giftable, gift_pdf_background_url, gift_custom_line_1, gift_custom_line_2, gift_custom_line_3, gift_validity_months)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30) RETURNING *`,
      [name, description || null, activity_ski || false, activity_snowboard || false, activity_pedestrian || false, activity_children || false, activity_gopro || false, duration_minutes, price_cents, start, end, color_code, slots, flightSeason, allow_multi_slots || false, weight_min || 20, weight_max || 110, booking_delay_hours || 0, image_url || null, popup_content || null, show_popup || false, media_included || false, passengers_per_slot || 1, flightTenant, is_giftable || false, gift_pdf_background_url || null, gift_custom_line_1 || null, gift_custom_line_2 || null, gift_custom_line_3 || null, gift_validity_months || 12]
    );
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.put('/api/flight-types/:id', authenticateAdminOrPartner, validate(FlightTypeSchema), async (req, res) => {
  const { name, description, activity_ski, activity_snowboard, activity_pedestrian, activity_children, activity_gopro, duration_minutes, price_cents, restricted_start_time, restricted_end_time, color_code, allowed_time_slots, season, allow_multi_slots, weight_min, weight_max, booking_delay_hours, image_url, popup_content, show_popup, media_included, passengers_per_slot, is_giftable, gift_pdf_background_url, gift_custom_line_1, gift_custom_line_2, gift_custom_line_3, gift_validity_months } = req.body;
  const start = restricted_start_time === '' ? null : restricted_start_time;
  const end = restricted_end_time === '' ? null : restricted_end_time;
  const slots = allowed_time_slots ? JSON.stringify(allowed_time_slots) : '[]';
  const flightSeason = season || 'Standard';

  try {
    await pool.query(
      `UPDATE flight_types
       SET name=$1, description=$2, activity_ski=$3, activity_snowboard=$4, activity_pedestrian=$5, activity_children=$6, activity_gopro=$7, duration_minutes=$8, price_cents=$9, restricted_start_time=$10, restricted_end_time=$11, color_code=$12, allowed_time_slots=$13, season=$14, allow_multi_slots=$15, weight_min=$16, weight_max=$17, booking_delay_hours=$18, image_url=$19, popup_content=$20, show_popup=$21, media_included=$23, passengers_per_slot=$24, is_giftable=$25, gift_pdf_background_url=$26, gift_custom_line_1=$27, gift_custom_line_2=$28, gift_custom_line_3=$29, gift_validity_months=$30
       WHERE id=$22`,
      [name, description || null, activity_ski || false, activity_snowboard || false, activity_pedestrian || false, activity_children || false, activity_gopro || false, duration_minutes, price_cents, start, end, color_code, slots, flightSeason, allow_multi_slots || false, weight_min || 20, weight_max || 110, booking_delay_hours || 0, image_url || null, popup_content || null, show_popup || false, req.params.id, media_included || false, passengers_per_slot || 1, is_giftable || false, gift_pdf_background_url || null, gift_custom_line_1 || null, gift_custom_line_2 || null, gift_custom_line_3 || null, gift_validity_months || 12]
    );
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});
 
router.delete('/api/flight-types/:id', authenticateAdminOrPartner, async (req, res) => {
  try {
    await pool.query('DELETE FROM flight_types WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: "Impossible de supprimer ce vol car il est utilisé." }); 
  }
});

router.get('/api/complements', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM complements WHERE is_active = true ORDER BY price_cents ASC');
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/api/complements', authenticateAdmin, async (req, res) => {
  const { name, description, price_cents, image_url } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO complements (name, description, price_cents, is_active, image_url) VALUES ($1, $2, $3, true, $4) RETURNING *',
      [name, description, price_cents, image_url || null]
    );
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.delete('/api/complements/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM complements WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});


module.exports = router;
