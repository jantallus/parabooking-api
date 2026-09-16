const express = require('express');
const router = express.Router();
const db = require('../db');
const { pool } = db;
const { authenticateUser, authenticateAdmin, authenticateAdminOrPartner } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { QuickPatchSchema } = require('../schemas');
const { googleSyncCache, invalidateCacheForMonitor } = require('../services/googleSync');
const { notifyGoogleCalendar, deleteGoogleCalendarEvent } = require('../services/email');

// Enregistre un snapshot du créneau dans l'historique avant chaque mutation significative
async function logSlotHistory(slotId, action, userEmail) {
  try {
    const r = await pool.query(
      `SELECT s.id, s.title, s.status, s.phone, s.email, s.notes, s.weight,
              s.flight_type_id, ft.name AS flight_type_name, ft.tenant AS flight_type_tenant,
              s.second_booking, s.payment_data, s.monitor_id,
              TO_CHAR(s.start_time, 'YYYY-MM-DD HH24:MI') AS start_time,
              TO_CHAR(s.end_time,   'YYYY-MM-DD HH24:MI') AS end_time
       FROM slots s
       LEFT JOIN flight_types ft ON ft.id = s.flight_type_id
       WHERE s.id = $1`, [slotId]
    );
    if (r.rows.length === 0) return;
    await pool.query(
      `INSERT INTO slot_history (slot_id, action, changed_by_email, snapshot)
       VALUES ($1, $2, $3, $4)`,
      [slotId, action, userEmail || null, JSON.stringify(r.rows[0])]
    );
  } catch (e) {
    console.error('logSlotHistory error:', e.message);
  }
}

// Lit les créneaux Google occupés depuis le cache (chargé par googleSync.js toutes les 2 min)
async function getGoogleBusySlots(monitorName, webhookUrl) {
  const monRes = await pool.query(
    "SELECT id FROM users WHERE first_name = $1 AND is_active_monitor = true LIMIT 1",
    [monitorName]
  );
  if (monRes.rows.length === 0) return [];

  const cached = googleSyncCache.get(monRes.rows[0].id);
  if (cached && Array.isArray(cached)) {
    return cached.map(g => ({ start: new Date(g.start).getTime(), end: new Date(g.end).getTime() }));
  }

  try {
    const url = webhookUrl + '?monitorName=' + encodeURIComponent(monitorName);
    const resp = await fetch(url);
    const text = await resp.text();
    const slots = JSON.parse(text);
    if (Array.isArray(slots)) {
      googleSyncCache.set(monRes.rows[0].id, slots);
      return slots.map(g => ({ start: new Date(g.start).getTime(), end: new Date(g.end).getTime() }));
    }
    return [];
  } catch (e) {
    return [];
  }
}

router.get('/api/slots', authenticateUser, async (req, res) => {
  try {
    const { start, end } = req.query;
    let query = 'SELECT * FROM slots WHERE 1=1';
    let params = [];

    if (req.user.role === 'monitor' || req.user.role === 'permanent') {
      params.push(req.user.id);
      query += ` AND monitor_id = $${params.length}`;
    }

    if (start && end) {
      params.push(start, end);
      query += ` AND start_time >= $${params.length - 1} AND start_time <= $${params.length}`;
    } else {
      query += ` AND start_time >= NOW() - INTERVAL '1 month' AND start_time <= NOW() + INTERVAL '6 months'`;
    }

    query += ' ORDER BY start_time ASC';
    const r = await pool.query(query, params);
    let slots = r.rows;

    // Marquage des créneaux tombant dans une période d'indisponibilité moniteur
    const monitorIdsForAvail = [...new Set(slots.map(s => s.monitor_id).filter(Boolean))];
    if (monitorIdsForAvail.length > 0) {
      const avRes = await pool.query(
        `SELECT user_id,
                TO_CHAR(start_date, 'YYYY-MM-DD') as start_date,
                TO_CHAR(end_date, 'YYYY-MM-DD') as end_date
         FROM monitor_availabilities WHERE user_id = ANY($1)`,
        [monitorIdsForAvail]
      );
      const unavailMap = {};
      for (const row of avRes.rows) {
        if (!unavailMap[row.user_id]) unavailMap[row.user_id] = [];
        unavailMap[row.user_id].push(row);
      }
      slots = slots.map(slot => {
        if (slot.status !== 'available' || !slot.monitor_id) return slot;
        const periods = unavailMap[slot.monitor_id];
        if (!periods || periods.length === 0) return slot;
        const slotDateStr = new Date(slot.start_time).toISOString().slice(0, 10);
        const inUnavailability = periods.some(p => slotDateStr >= p.start_date && slotDateStr <= p.end_date);
        if (inUnavailability) return { ...slot, status: 'booked', title: 'NON DISPO', notes: 'Indisponibilité du moniteur' };
        return slot;
      });
    }

    // 🎯 VÉRIFICATION: Le partage Google est-il activé ?
    const syncSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
    const isGoogleSyncEnabled = syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true';

    if (isGoogleSyncEnabled) {
      // 🎯 SYNC GOOGLE : Version ultra-rapide avec Cache
      const webhookUrl = process.env.GOOGLE_SCRIPT_URL;
      if (!webhookUrl) { res.json(slots); return; }
      const monitorIds = [...new Set(slots.map(s => s.monitor_id).filter(id => id != null))];
      
      await Promise.all(monitorIds.map(async (mId) => {
        try {
          const monRes = await pool.query('SELECT first_name FROM users WHERE id = $1', [mId]);
          if (monRes.rows.length > 0) {
            const mName = monRes.rows[0].first_name;
            const googleBusySlots = await getGoogleBusySlots(mName, webhookUrl);

            slots = slots.map(slot => {
              const slotStart = new Date(slot.start_time).getTime();
              const slotEnd = new Date(slot.end_time).getTime();
              const isBusy = googleBusySlots.some(g => slotStart < g.end && slotEnd > g.start);
              if (slot.monitor_id === mId && isBusy && slot.status === 'available') {
                return { ...slot, status: 'booked', title: '🚫 BLOQUÉ (Google)', notes: 'Indisponibilité notée sur l\'agenda perso' };
              }
              return slot;
            });
          }
        } catch (e) { console.error(`Erreur sync Google pour ${mId}`); }
      }));
    }

    res.json(slots);
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

router.patch('/api/slots/:id', authenticateUser, async (req, res) => {
  let { title, weight, flight_type_id, notes, status, monitor_id, phone, email, weightChecked, booking_options, client_message, second_booking } = req.body;
  const hasSecondBookingUpdate = 'second_booking' in req.body;
  const slotId = req.params.id;

  try {
    if (req.user.role === 'monitor') {
      return res.status(403).json({ error: "Mode lecture seule : Vous ne pouvez pas modifier le planning." });
    }

    if (req.user.role === 'permanent') {
      const checkRes = await pool.query('SELECT monitor_id, title, status FROM slots WHERE id = $1', [slotId]);
      if (checkRes.rows.length > 0) {
        const slot = checkRes.rows[0];
        if (slot.monitor_id !== req.user.id) {
          return res.status(403).json({ error: "Vous ne pouvez agir que sur votre propre planning." });
        }
        const isClientSlot = slot.status === 'booked' && slot.title && !['NOTE', '☕ PAUSE', 'NON DISPO'].some(t => slot.title.includes(t)) && !slot.title.includes('❌');
        const isMakingClientSlot = status === 'booked' && title && !['NOTE', '☕ PAUSE', 'NON DISPO'].some(t => title.includes(t)) && !title.includes('❌');
        if (isClientSlot || isMakingClientSlot) {
          return res.status(403).json({ error: "Les moniteurs permanents ne peuvent pas modifier les réservations clients." });
        }
        if (slot.title && slot.title.includes('(Admin)')) {
          return res.status(403).json({ error: "Action refusée : Ce créneau est verrouillé par la Direction." });
        }
      }
    }

    if (req.user.role === 'admin' && (title === 'NON DISPO' || title === '☕ PAUSE')) {
      title = `${title} (Admin)`;
    }

    await logSlotHistory(slotId, 'update', req.user.email);

    const result = await pool.query(
      `UPDATE slots
      SET title = $1, weight = $2, flight_type_id = $3, notes = $4, status = $5,
          monitor_id = COALESCE($6, monitor_id), phone = $8, email = $9, weight_checked = $10,
          booking_options = $11, client_message = $12,
          payment_data = COALESCE($13, payment_data),
          second_booking = CASE WHEN $14::boolean THEN $15::jsonb ELSE second_booking END
      WHERE id = $7 RETURNING *`,
      [
        title !== undefined ? title : null, weight ? parseInt(weight) : null, flight_type_id ? parseInt(flight_type_id) : null,
        notes !== undefined ? notes : null, status || 'available', monitor_id ? parseInt(monitor_id) : null, slotId,
        phone !== undefined ? phone : null, email !== undefined ? email : null, weightChecked !== undefined ? weightChecked : false,
        booking_options !== undefined ? booking_options : null, client_message !== undefined ? client_message : null,
        req.body.payment_data !== undefined ? JSON.stringify(req.body.payment_data) : null,
        hasSecondBookingUpdate,
        hasSecondBookingUpdate ? (second_booking !== null ? JSON.stringify(second_booking) : null) : null
      ]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Créneau introuvable" });

    const updatedSlot = result.rows[0];

    // Quand un créneau est libéré : invalide le cache ET supprime l'événement Google
    if (updatedSlot.status === 'available' && updatedSlot.monitor_id) {
      invalidateCacheForMonitor(updatedSlot.monitor_id);

      const syncSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
      if (syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true') {
        const monRes = await pool.query('SELECT first_name, google_sync_enabled FROM users WHERE id = $1', [updatedSlot.monitor_id]);
        if (monRes.rows.length > 0 && monRes.rows[0].google_sync_enabled) {
          await deleteGoogleCalendarEvent(monRes.rows[0].first_name, updatedSlot.start_time, updatedSlot.end_time);
        }
      }
    }

    // 🎯 SYNC GOOGLE : Envoi des réservations manuelles depuis le backoffice
    // On vérifie que c'est une vraie réservation client
    if (updatedSlot.status === 'booked' && updatedSlot.title && 
        !['NOTE', '☕ PAUSE', 'NON DISPO'].some(t => updatedSlot.title.includes(t)) && 
        !updatedSlot.title.includes('❌') && 
        !updatedSlot.title.startsWith('↪️ Suite')) {
      
      try {
        // 🎯 L'INTERRUPTEUR EST ICI : On vérifie si la synchro est activée en base de données
        const syncSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
        if (syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true') {
          
          const monRes = await pool.query('SELECT first_name FROM users WHERE id = $1', [updatedSlot.monitor_id]);
          if (monRes.rows.length > 0) {
            const monitorName = monRes.rows[0].first_name;

            let desc = "Créé depuis le backoffice\n";
            if (updatedSlot.phone) desc += `Tel: ${updatedSlot.phone}\n`;
            if (updatedSlot.booking_options) desc += `Options: ${updatedSlot.booking_options}\n`;
            if (updatedSlot.notes) desc += `Notes internes: ${updatedSlot.notes}\n`;
            if (updatedSlot.client_message) desc += `Message client: ${updatedSlot.client_message}\n`;

            notifyGoogleCalendar(monitorName, updatedSlot.title, updatedSlot.start_time, updatedSlot.end_time, desc);
            await pool.query(
              `UPDATE slots SET payment_data = COALESCE(payment_data, '{}') || '{"google_synced": true}'::jsonb WHERE id = $1`,
              [updatedSlot.id]
            );
          }
        }
      } catch(e) { console.error("Erreur Synchro Google Admin:", e); }
    }

    // Auto-passage "effectué" dans la demande liée si paiement enregistré sur date passée
    const pd = req.body.payment_data;
    const hasPayment = pd && pd.payment_type && pd.payment_type !== '' && pd.payment_type !== 'np';
    if (hasPayment && updatedSlot.status === 'booked' && new Date(updatedSlot.start_time) < new Date()) {
      await pool.query(
        `UPDATE standby_clients SET status='done', updated_at=NOW() WHERE slot_id=$1 AND status='scheduled'`,
        [updatedSlot.id]
      );
    }

    res.json(updatedSlot);

  } catch (err) {
    console.error("ERREUR PATCH SLOT:", err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.patch('/api/slots/:id/quick', authenticateUser, validate(QuickPatchSchema), async (req, res) => {
  const { payment_data, monitor_id, billing_name, booking_options } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const currentSlotRes = await client.query('SELECT * FROM slots WHERE id = $1', [req.params.id]);
    if (currentSlotRes.rows.length === 0) throw new Error("Créneau introuvable");
    const currentSlot = currentSlotRes.rows[0];

    if (payment_data !== undefined) {
      await client.query('UPDATE slots SET payment_data = $1 WHERE id = $2', [payment_data ? JSON.stringify(payment_data) : null, req.params.id]);
    }
    if (booking_options !== undefined) {
      await client.query('UPDATE slots SET booking_options = $1 WHERE id = $2', [booking_options || null, req.params.id]);
    }

    if (billing_name !== undefined) {
      // Propage à tous les slots du même group_id si possible
      if (currentSlot.group_id) {
        await client.query('UPDATE slots SET billing_name = $1 WHERE group_id = $2', [billing_name || null, currentSlot.group_id]);
      } else {
        await client.query('UPDATE slots SET billing_name = $1 WHERE id = $2', [billing_name || null, req.params.id]);
      }
    }

    if (monitor_id !== undefined) {
       const targetMonitor = monitor_id || null;
       if (targetMonitor && targetMonitor !== currentSlot.monitor_id) {
         const targetSlotRes = await client.query('SELECT * FROM slots WHERE monitor_id = $1 AND start_time = $2', [targetMonitor, currentSlot.start_time]);
         if (targetSlotRes.rows.length > 0) {
            const targetSlot = targetSlotRes.rows[0];
            if (targetSlot.status !== 'available' && targetSlot.title !== 'NOTE') {
               throw new Error("Ce pilote a déjà un vol prévu à cette heure-là !");
            }
            await client.query('UPDATE slots SET monitor_id = NULL WHERE id = $1', [targetSlot.id]);
            await client.query('UPDATE slots SET monitor_id = $1 WHERE id = $2', [targetMonitor, currentSlot.id]);
            await client.query('UPDATE slots SET monitor_id = $1 WHERE id = $2', [currentSlot.monitor_id, targetSlot.id]);
         } else {
            await client.query('UPDATE slots SET monitor_id = $1 WHERE id = $2', [targetMonitor, currentSlot.id]);
         }
       } else if (!targetMonitor) {
         await client.query('UPDATE slots SET monitor_id = NULL WHERE id = $1', [currentSlot.id]);
       }
    }

    await client.query('COMMIT');
    const finalSlot = await client.query('SELECT * FROM slots WHERE id = $1', [req.params.id]);
    res.json(finalSlot.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message }); 
  } finally {
    client.release();
  }
});

router.post('/api/delete-slots', authenticateAdminOrPartner, async (req, res) => {
  const { startDate, endDate, monitor_id, monitor_ids, forceOverwrite } = req.body;
  if (!startDate || !endDate) return res.status(400).json({ error: 'Dates manquantes.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const params = [startDate, endDate];
    let monitorFilter = '';
    if (monitor_ids && monitor_ids.length > 0) {
      monitorFilter = ' AND monitor_id = ANY($3)';
      params.push(monitor_ids);
    } else if (monitor_id && monitor_id !== 'all') {
      monitorFilter = ' AND monitor_id = $3';
      params.push(monitor_id);
    }

    if (!forceOverwrite) {
      const check = await client.query(
        `SELECT COUNT(*) FROM slots
         WHERE start_time::date >= $1 AND start_time::date <= $2
         AND ((title IS NOT NULL AND title != '' AND title != '☕ PAUSE' AND UPPER(title) NOT LIKE 'NON DISPO%') OR (notes IS NOT NULL AND trim(notes) != '' AND UPPER(COALESCE(title, '')) NOT LIKE 'NON DISPO%'))
         ${monitorFilter}`,
        params
      );
      if (parseInt(check.rows[0].count) > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          warning: true,
          message: `⚠️ ATTENTION : Il y a ${check.rows[0].count} réservation(s) ou note(s) sur cette période. Voulez-vous VRAIMENT tout supprimer ?`,
        });
      }
    }

    const r = await client.query(
      `DELETE FROM slots WHERE start_time::date >= $1 AND start_time::date <= $2 ${monitorFilter}`,
      params
    );
    await client.query('COMMIT');
    res.json({ deleted: r.rowCount });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.post('/api/generate-slots', authenticateAdminOrPartner, async (req, res) => {
  const { startDate, endDate, daysToApply, plan_name, monitor_id, monitor_ids, blocked_pilot_ids, forceOverwrite, ignoreUnavailability } = req.body;
  const plan = plan_name || 'Standard';
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    let monitorFilterDelete = '';
    let monitorFilterSelect = '';
    const paramsSelect = [];
    const paramsDelete = [startDate, endDate];

    if (monitor_ids && monitor_ids.length > 0) {
        monitorFilterDelete = ' AND monitor_id = ANY($3)';
        paramsDelete.push(monitor_ids);
        monitorFilterSelect = ' AND id = ANY($1)';
        paramsSelect.push(monitor_ids);
    } else if (monitor_id && monitor_id !== 'all') {
        monitorFilterDelete = ' AND monitor_id = $3';
        paramsDelete.push(monitor_id);
        monitorFilterSelect = ' AND id = $1';
        paramsSelect.push(monitor_id);
    }

    if (!forceOverwrite) {
        const checkQuery = `
          SELECT COUNT(*) FROM slots
          WHERE start_time::date >= $1
          AND start_time::date <= $2
          AND ((title IS NOT NULL AND title != '' AND title != '☕ PAUSE' AND UPPER(title) NOT LIKE 'NON DISPO%') OR (notes IS NOT NULL AND trim(notes) != '' AND UPPER(COALESCE(title, '')) NOT LIKE 'NON DISPO%'))
          ${monitorFilterDelete}
        `;
        const check = await client.query(checkQuery, paramsDelete);
        if (parseInt(check.rows[0].count) > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                warning: true,
                message: `⚠️ ATTENTION : Il y a ${check.rows[0].count} réservation(s) ou note(s) importante(s) sur cette période. Voulez-vous VRAIMENT tout écraser ?`
            });
        }
    }

    // Vérifie que les AUTRES pilotes sur ces jours n'ont pas un plan différent
    if (monitor_ids && monitor_ids.length > 0) {
        const planCheck = await client.query(
            `SELECT DISTINCT plan_name FROM slots
             WHERE start_time::date >= $1
               AND start_time::date <= $2
               AND monitor_id != ALL($3)
               AND plan_name IS NOT NULL
               AND plan_name != ''`,
            [startDate, endDate, monitor_ids]
        );
        const existingPlans = planCheck.rows.map(r => r.plan_name).filter(p => p !== plan);
        if (existingPlans.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                planConflict: true,
                message: `❌ Impossible : d'autres pilotes ont déjà des créneaux générés avec le plan « ${existingPlans[0]} » sur cette période. Choisissez ce même plan pour rester cohérent.`,
                existingPlan: existingPlans[0],
            });
        }
    }
    
    await client.query(`DELETE FROM slots WHERE start_time::date >= $1 AND start_time::date <= $2 ${monitorFilterDelete}`, paramsDelete);
    
    const defs = await client.query("SELECT * FROM slot_definitions WHERE COALESCE(plan_name, 'Standard') = $1", [plan]);
    const mons = await client.query(`SELECT id, available_start_date, available_end_date, daily_start_time, daily_end_time FROM users WHERE is_active_monitor = true AND status = 'Actif' ${monitorFilterSelect}`, paramsSelect);
    
    // Chargement unique des disponibilités moniteurs (évite N requêtes dans la boucle)
    const availsResult = await client.query('SELECT * FROM monitor_availabilities');
    const availsByMonitor = {};
    for (const a of availsResult.rows) {
      if (!availsByMonitor[a.user_id]) availsByMonitor[a.user_id] = [];
      availsByMonitor[a.user_id].push(a);
    }

    let curr = new Date(startDate);
    const last = new Date(endDate);
    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    while (curr <= last) {
      const activeDays = daysToApply.map(Number);
      if (activeDays.includes(curr.getDay())) {
        const dateStr = curr.getFullYear() + '-' + String(curr.getMonth() + 1).padStart(2, '0') + '-' + String(curr.getDate()).padStart(2, '0');
        
        for (const d of defs.rows) {
          for (const m of mons.rows) {
            const startTS = `${dateStr} ${d.start_time}`;
            const isPause = (d.label === 'PAUSE' || d.label === '☕ PAUSE');

            const monitorUnavails = availsByMonitor[m.id] || [];
            const isUnavailable = !isPause && !ignoreUnavailability && monitorUnavails.some(a => {
              const currStr = curr.toISOString().slice(0, 10);
              return currStr >= a.start_date && currStr <= a.end_date;
            });

              const isBlocked = !isPause && (isUnavailable || (blocked_pilot_ids && blocked_pilot_ids.includes(String(m.id))));
              const slotStatus = isPause || isBlocked ? 'booked' : 'available';
              const slotTitle = isPause ? '☕ PAUSE' : isBlocked ? 'NON DISPO' : null;
              placeholders.push(`($${paramIndex}, $${paramIndex+1}::timestamp, $${paramIndex+1}::timestamp + ($${paramIndex+2} || ' minutes')::interval, $${paramIndex+3}, $${paramIndex+4}, $${paramIndex+5})`);
              values.push(m.id, startTS, d.duration_minutes, slotStatus, slotTitle, isPause ? null : plan);
              paramIndex += 6;
            }
          }
      }
      curr.setDate(curr.getDate() + 1);
    }

    if (placeholders.length > 0) {
      await client.query(`INSERT INTO slots (monitor_id, start_time, end_time, status, title, plan_name) VALUES ${placeholders.join(', ')}`, values);
    }

    await client.query('COMMIT');
    res.json({ success: true, count: placeholders.length, debug: { monitorsFound: mons.rows.length, defsFound: defs.rows.length } });
    
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { 
    client.release(); 
  }
});

router.post('/api/replace-monitor', authenticateUser, async (req, res) => {
  const { fromMonitorId, toMonitorId, startDate, endDate } = req.body;
  if (!fromMonitorId || !toMonitorId || !startDate || !endDate) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Supprimer les créneaux non-réservés du remplaçant (libres, NON DISPO, pauses)
    // pour libérer la place avant le transfert
    await client.query(
      `DELETE FROM slots
       WHERE monitor_id = $1 AND start_time::date BETWEEN $2 AND $3
         AND (status = 'available'
              OR title LIKE '☕%'
              OR UPPER(COALESCE(title,'')) LIKE '%NON DISPO%'
              OR UPPER(COALESCE(title,'')) LIKE '%PAUSE%')`,
      [toMonitorId, startDate, endDate]
    );

    // Compter les créneaux à transférer avant la mise à jour
    const countBefore = await client.query(
      `SELECT COUNT(*) FROM slots WHERE monitor_id = $1 AND start_time::date BETWEEN $2 AND $3`,
      [fromMonitorId, startDate, endDate]
    );
    const totalToTransfer = parseInt(countBefore.rows[0].count);

    // Transférer les créneaux du moniteur malade, en sautant les conflits
    // (créneaux où le remplaçant a déjà une vraie réservation à cet horaire)
    const result = await client.query(
      `UPDATE slots SET monitor_id = $1
       WHERE monitor_id = $2 AND start_time::date BETWEEN $3 AND $4
         AND NOT EXISTS (
           SELECT 1 FROM slots s2
           WHERE s2.monitor_id = $1 AND s2.start_time = slots.start_time
         )`,
      [toMonitorId, fromMonitorId, startDate, endDate]
    );

    // Récupérer les slots booked+google_synced qui viennent d'être transférés
    // (maintenant sur toMonitorId) pour supprimer leurs événements Google de l'ancien agenda
    const transferredBookings = await client.query(
      `SELECT start_time, end_time FROM slots
       WHERE monitor_id = $1 AND start_time::date BETWEEN $2 AND $3
         AND status = 'booked' AND payment_data->>'google_synced' = 'true'`,
      [toMonitorId, startDate, endDate]
    );

    await client.query('COMMIT');

    // Nettoyage Google Agenda : supprimer les événements de l'ancien moniteur
    // (sans bloquer la réponse en cas d'erreur)
    if (transferredBookings.rows.length > 0) {
      try {
        const syncSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
        if (syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true') {
          const fromMonRes = await pool.query(
            'SELECT first_name, google_sync_enabled FROM users WHERE id = $1',
            [fromMonitorId]
          );
          if (fromMonRes.rows.length > 0 && fromMonRes.rows[0].google_sync_enabled) {
            const fromName = fromMonRes.rows[0].first_name;
            for (const slot of transferredBookings.rows) {
              try {
                await deleteGoogleCalendarEvent(fromName, slot.start_time, slot.end_time);
              } catch (e) { console.error('Google delete event error:', e.message); }
            }
            invalidateCacheForMonitor(fromMonitorId);
          }
        }
      } catch (e) { console.error('Google sync cleanup error:', e.message); }
    }

    const skipped = totalToTransfer - result.rowCount;
    res.json({ success: true, count: result.rowCount, skipped });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/api/slot-definitions', async (req, res) => {
  try {
    const { plan } = req.query;
    const query = plan ? 'SELECT * FROM slot_definitions WHERE plan_name = $1 ORDER BY start_time' : 'SELECT * FROM slot_definitions ORDER BY start_time';
    const result = await pool.query(query, plan ? [plan] : []);
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/api/slot-definitions', authenticateAdminOrPartner, async (req, res) => {
  try {
    const { start_time, duration_minutes, label, plan_name } = req.body;
    const r = await pool.query(
      `INSERT INTO slot_definitions (start_time, duration_minutes, label, plan_name) VALUES ($1, $2, $3, $4) RETURNING *`,
      [start_time, duration_minutes, label, plan_name || 'Standard']
    );
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.put('/api/slot-definitions/:id', authenticateAdminOrPartner, async (req, res) => {
  const { start_time, duration_minutes, label, plan_name } = req.body;
  try {
    await pool.query('UPDATE slot_definitions SET start_time = $1, duration_minutes = $2, label = $3, plan_name = $4 WHERE id = $5', [start_time, duration_minutes, label, plan_name || 'Standard', req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.delete('/api/slot-definitions/:id', authenticateAdminOrPartner, async (req, res) => {
  try {
    await pool.query('DELETE FROM slot_definitions WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.put('/api/plans/:oldName', authenticateAdminOrPartner, async (req, res) => {
  try {
    await pool.query('UPDATE slot_definitions SET plan_name = $1 WHERE plan_name = $2', [req.body.newName, req.params.oldName]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.delete('/api/plans/:name', authenticateAdminOrPartner, async (req, res) => {
  try {
    await pool.query('DELETE FROM slot_definitions WHERE plan_name = $1', [req.params.name]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});


router.delete('/api/slots/:id', authenticateUser, async (req, res) => {
  try {
    // On récupère le code cadeau avant de vider le créneau
    const slotRes = await pool.query('SELECT payment_data FROM slots WHERE id = $1', [req.params.id]);
    if (slotRes.rows.length > 0 && slotRes.rows[0].payment_data) {
      const pd = slotRes.rows[0].payment_data;
      if (pd.code && pd.code_type === 'gift_card') {
        await pool.query(`DELETE FROM gift_cards WHERE UPPER(code) = $1 AND type = 'gift_card'`, [pd.code.toUpperCase()]);
      }
    }

    await logSlotHistory(req.params.id, 'delete', req.user?.email);

    // Le nettoyage du créneau
    await pool.query(
      `UPDATE slots SET status = 'available', payment_data = NULL, title = NULL, notes = NULL, phone = NULL, email = NULL, booking_options = NULL, client_message = NULL, flight_type_id = NULL, weight_checked = false, weight = NULL, second_booking = NULL WHERE id = $1`, [req.params.id]
    );
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});


// Historique des modifications d'un créneau
router.get('/api/slots/:id/history', authenticateUser, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, action, changed_by_email,
              TO_CHAR(changed_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD HH24:MI') AS changed_at,
              snapshot
       FROM slot_history
       WHERE slot_id = $1
       ORDER BY changed_at DESC
       LIMIT 20`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
