const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { pool } = db;
const { authenticateUser, authenticateAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { CheckoutSchema, CheckoutGiftCardSchema } = require('../schemas');
const Stripe = require('stripe');
const { sendConfirmationEmail, sendConfirmationSMS, sendAdminNotificationEmail } = require('../services/email');
const { generatePDFBuffer } = require('../services/pdf');
const { googleSyncCache } = require('../services/googleSync');
const { performBooking } = require('../services/booking');
const { processStripeSession } = require('../services/stripeProcessor');
const { generateICalFeed } = require('../services/ical');

// ── Rate limiters ──────────────────────────────────────────────────────────────

// Création de session Stripe (vol + bon cadeau) : max 8 tentatives / 15 min / IP
// Empêche le spam de sessions Stripe (coût + pollution dashboard)
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: { error: 'Trop de tentatives de paiement. Veuillez réessayer dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Confirmation de paiement : max 20 tentatives / 15 min / IP
// Empêche le bruteforce de session IDs Stripe
const confirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Trop de requêtes. Veuillez réessayer dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Disponibilités : max 60 requêtes / minute / IP (1/s en moyenne)
// Limite le scraping tout en laissant l'usage normal du tunnel de réservation
const availabilitiesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Trop de requêtes. Veuillez patienter un instant.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/api/public/availabilities', availabilitiesLimiter, async (req, res) => {
  const { start, end } = req.query; 
  try {
    if (!start || !end) return res.status(400).json({ error: "Période requise" });
    
    // 1. Un seul appel pour récupérer la grille de la base de données
    const r = await pool.query(`SELECT id, start_time, end_time, status, monitor_id FROM slots WHERE start_time::date >= $1 AND start_time::date <= $2 ORDER BY start_time ASC`, [start, end]);
    let slots = r.rows;

    // 2. Disponibilités moniteurs : si un moniteur a des périodes définies,
    //    tout créneau hors période est considéré indisponible.
    const monitorIds = [...new Set(slots.map(s => s.monitor_id).filter(Boolean))];
    let monitorAvailMap = {};
    if (monitorIds.length > 0) {
      const avRes = await pool.query(
        `SELECT user_id,
                TO_CHAR(start_date, 'YYYY-MM-DD') as start_date,
                TO_CHAR(end_date, 'YYYY-MM-DD') as end_date,
                daily_start_time, daily_end_time
         FROM monitor_availabilities
         WHERE user_id = ANY($1)`,
        [monitorIds]
      );
      for (const row of avRes.rows) {
        if (!monitorAvailMap[row.user_id]) monitorAvailMap[row.user_id] = [];
        monitorAvailMap[row.user_id].push(row);
      }
    }

    slots = slots.map(slot => {
      if (slot.status !== 'available' || !slot.monitor_id) return slot;
      const periods = monitorAvailMap[slot.monitor_id];
      if (!periods || periods.length === 0) return slot; // pas de restriction définie
      const slotDate = new Date(slot.start_time);
      const slotDateStr = slotDate.toISOString().slice(0, 10);
      const inPeriod = periods.some(p => slotDateStr >= p.start_date && slotDateStr <= p.end_date);
      if (!inPeriod) return { ...slot, status: 'booked' };
      return slot;
    });

    const syncSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
    const isGoogleSyncEnabled = syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true';

    if (isGoogleSyncEnabled) {
      // Utilise un vrai test de chevauchement :
      // un créneau est bloqué si N'IMPORTE QUELLE partie de ce créneau tombe dans l'événement Google.
      slots = slots.map(slot => {
        if (slot.status === 'available' && slot.monitor_id) {
          const googleBusySlots = googleSyncCache.get(slot.monitor_id) || [];
          const slotStart = new Date(slot.start_time).getTime();
          const slotEnd = new Date(slot.end_time).getTime();
          const isBusy = googleBusySlots.some(g => slotStart < g.end && slotEnd > g.start);
          if (isBusy) return { ...slot, status: 'booked' };
        }
        return slot;
      });
    }

    res.json(slots);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/api/public/available-dates', availabilitiesLimiter, async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start et end requis' });
  try {
    const r = await pool.query(
      `SELECT DISTINCT TO_CHAR(s.start_time::date, 'YYYY-MM-DD') as date
       FROM slots s
       WHERE s.status = 'available'
         AND s.start_time::date >= $1::date
         AND s.start_time::date <= $2::date
         AND (
           NOT EXISTS (SELECT 1 FROM monitor_availabilities ma WHERE ma.user_id = s.monitor_id)
           OR EXISTS (
             SELECT 1 FROM monitor_availabilities ma
             WHERE ma.user_id = s.monitor_id
               AND s.start_time::date >= ma.start_date
               AND s.start_time::date <= ma.end_date
           )
         )
       ORDER BY date ASC`,
      [start, end]
    );
    res.json(r.rows.map(row => row.date));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

router.get('/api/public/next-available', availabilitiesLimiter, async (req, res) => {
  const { start } = req.query;
  if (!start) return res.status(400).json({ error: 'start requis' });
  try {
    const end = new Date(start);
    end.setMonth(end.getMonth() + 6);
    const endStr = end.toISOString().slice(0, 10);

    // Première date avec au moins un créneau disponible,
    // en tenant compte des périodes de disponibilité moniteur.
    const r = await pool.query(
      `SELECT TO_CHAR(MIN(s.start_time::date), 'YYYY-MM-DD') as date
       FROM slots s
       WHERE s.status = 'available'
         AND s.start_time::date >= $1::date
         AND s.start_time::date <= $2::date
         AND (
           -- Moniteur sans restriction : toujours dispo
           NOT EXISTS (
             SELECT 1 FROM monitor_availabilities ma WHERE ma.user_id = s.monitor_id
           )
           OR
           -- Moniteur avec restriction : la date doit être dans une période
           EXISTS (
             SELECT 1 FROM monitor_availabilities ma
             WHERE ma.user_id = s.monitor_id
               AND s.start_time::date >= ma.start_date
               AND s.start_time::date <= ma.end_date
           )
         )`,
      [start, endStr]
    );

    res.json({ date: r.rows[0]?.date ?? null });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

router.get('/api/public/partners/check/:code', availabilitiesLimiter, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, code, color_code, booking_fields FROM partners WHERE UPPER(code) = UPPER($1) AND is_active = true`,
      [req.params.code]
    );
    if (!rows.length) return res.status(404).json({ message: 'Code partenaire inconnu ou inactif.' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/api/public/site-settings', async (req, res) => {
  try {
    const r = await pool.query("SELECT key, value FROM site_settings WHERE key IN ('physical_gift_card_enabled', 'physical_gift_card_price', 'display_days_count')");
    const settings = r.rows.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {});
    res.json(settings);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/// 🎯 SECURISE : CREATION SESSION STRIPE BON CADEAU
router.post('/api/public/checkout-gift-card', checkoutLimiter, validate(CheckoutGiftCardSchema), async (req, res) => {
  const { template, buyer, physicalShipping, selectedComplements } = req.body;
  try {
    // ── Validation des champs obligatoires ────────────────────────────────────
    const templateId = template?.id;
    if (!templateId) return res.status(400).json({ error: 'Template ID manquant.' });
    if (!buyer || !buyer.name || !buyer.email) {
      return res.status(400).json({ error: 'Informations acheteur incomplètes (nom et email requis).' });
    }
    if (Array.isArray(selectedComplements) && selectedComplements.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 options par bon cadeau.' });
    }

    // ── Vérification du template en base (prix + statut publié) ───────────────
    // 🛡️ On ne fait jamais confiance aux prix envoyés par le client.
    const tplRes = await pool.query(
      'SELECT * FROM gift_card_templates WHERE id = $1 AND is_published = true',
      [templateId]
    );
    const tpl = tplRes.rows[0];
    if (!tpl) return res.status(400).json({ error: 'Modèle de bon cadeau introuvable ou non publié.' });

    const shipRes = await pool.query("SELECT value FROM site_settings WHERE key = 'physical_gift_card_price'");
    const shipPriceCents = shipRes.rows.length > 0 ? (parseInt(shipRes.rows[0].value) || 0) * 100 : 0;

    // Prix du bon cadeau — lu depuis la DB, pas depuis le client
    const line_items = [{
      price_data: {
        currency: 'eur',
        product_data: { name: tpl.title, description: `Bon cadeau offert par : ${buyer.name}` },
        unit_amount: tpl.price_cents
      },
      quantity: 1
    }];

    // Options (compléments) — seuls les IDs sont acceptés du client, prix relus en DB
    let optionsTotalCents = 0;
    let optionsText = '';
    if (Array.isArray(selectedComplements) && selectedComplements.length > 0) {
      const names = [];
      for (const comp of selectedComplements) {
        if (!comp?.id) return res.status(400).json({ error: 'ID option invalide.' });
        const compRes = await pool.query(
          'SELECT name, price_cents FROM complements WHERE id = $1 AND is_active = true',
          [comp.id]
        );
        const dbComp = compRes.rows[0];
        if (!dbComp) return res.status(400).json({ error: `Option introuvable ou désactivée (id: ${comp.id})` });

        optionsTotalCents += dbComp.price_cents;
        names.push(dbComp.name);
        line_items.push({
          price_data: {
            currency: 'eur',
            product_data: { name: `Option incluse : ${dbComp.name}` },
            unit_amount: dbComp.price_cents
          },
          quantity: 1
        });
      }
      optionsText = `Options incluses : ${names.join(', ')}\n`;
    }

    // Envoi postal — prix lu en DB, adresse validée
    const shippingAddress = physicalShipping?.enabled && physicalShipping?.address
      ? String(physicalShipping.address).substring(0, 499)
      : '';
    if (physicalShipping?.enabled && !shippingAddress) {
      return res.status(400).json({ error: 'Adresse postale manquante.' });
    }
    if (physicalShipping?.enabled && shipPriceCents > 0) {
      line_items.push({
        price_data: {
          currency: 'eur',
          product_data: { name: "📮 Envoi Postal", description: "Carte glacée imprimée envoyée par courrier" },
          unit_amount: shipPriceCents
        },
        quantity: 1
      });
    }

    const sessionConfig = {
      payment_method_types: ['card'],
      customer_email: buyer.email,
      line_items,
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/succes?session_id={CHECKOUT_SESSION_ID}&embed=true`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/bons-cadeaux?embed=true`,
      metadata: {
        purchase_type: 'gift_card',
        buyer_name: String(buyer.name).substring(0, 499),
        buyer_email: String(buyer.email).substring(0, 499),
        buyer_phone: String(buyer.phone || '').substring(0, 499),
        price_paid_cents: String(tpl.price_cents + optionsTotalCents),
        validity_months: String(tpl.validity_months || 12),
        flight_type_id: String(tpl.flight_type_id || ''),
        pdf_background_url: String(tpl.pdf_background_url || '').substring(0, 499),
        buyer_address: shippingAddress,
        notes: String(optionsText).substring(0, 499),
        custom_line_1: String(tpl.custom_line_1 || '').substring(0, 80),
        custom_line_2: String(tpl.custom_line_2 || '').substring(0, 80),
        custom_line_3: String(tpl.custom_line_3 || '').substring(0, 80)
      }
    };

    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url });
  } catch (err) {
    console.error("Erreur Checkout Stripe Cadeau:", err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/api/public/checkout', checkoutLimiter, validate(CheckoutSchema), async (req, res) => {
  const { contact, passengers, voucher_code, partner_code } = req.body;

  // Limite configurable depuis le backoffice (clé : max_passengers_per_booking, défaut : 8)
  if (!Array.isArray(passengers) || passengers.length === 0) {
    return res.status(400).json({ error: 'Liste de passagers invalide.' });
  }
  const maxPassSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'max_passengers_per_booking'");
  const maxPassengers = maxPassSetting.rows.length > 0 ? (parseInt(maxPassSetting.rows[0].value) || 8) : 8;
  if (passengers.length > maxPassengers) {
    return res.status(400).json({ error: `Maximum ${maxPassengers} passagers par réservation.` });
  }

  const client = await pool.connect();

  try {
    let flightTotalCents = 0;
    let complementsTotalCents = 0;
    const line_items = [];

    for (const p of passengers) {
      // On vérifie que le vol existe ET est actif — rejette les IDs invalides ou désactivés
      const flightRes = await client.query('SELECT name, price_cents FROM flight_types WHERE id = $1 AND is_active = true', [p.flightId]);
      const flight = flightRes.rows[0];
      if (!flight) {
        return res.status(400).json({ error: `Type de vol introuvable ou désactivé (id: ${p.flightId})` });
      }
      flightTotalCents += flight.price_cents;
      line_items.push({
        price_data: { currency: 'eur', product_data: { name: `Vol ${flight.name}`, description: `Passager: ${p.firstName} - Le ${p.date} à ${p.time}` }, unit_amount: flight.price_cents }, quantity: 1
      });

      if (p.selectedComplements && p.selectedComplements.length > 0) {
        for (const compId of p.selectedComplements) {
          const compRes = await client.query('SELECT name, price_cents FROM complements WHERE id = $1 AND is_active = true', [compId]);
          const comp = compRes.rows[0];
          if (!comp) {
            return res.status(400).json({ error: `Option introuvable ou désactivée (id: ${compId})` });
          }
          complementsTotalCents += comp.price_cents;
          line_items.push({
            price_data: { currency: 'eur', product_data: { name: `Option: ${comp.name} (pour ${p.firstName})` }, unit_amount: comp.price_cents }, quantity: 1
          });
        }
      }
    }

    // Vérification que les créneaux sont toujours disponibles avant d'ouvrir Stripe
    for (const p of passengers) {
      const flightDurRes = await client.query('SELECT duration_minutes FROM flight_types WHERE id = $1', [p.flightId]);
      const flightDur = flightDurRes.rows[0]?.duration_minutes || 15;
      const slotsRes = await client.query(
        `SELECT * FROM slots WHERE start_time::date = $1 AND status = 'available' ORDER BY start_time ASC`,
        [p.date]
      );
      const monSchedules = {};
      slotsRes.rows.forEach(s => {
        if (!monSchedules[s.monitor_id]) monSchedules[s.monitor_id] = [];
        monSchedules[s.monitor_id].push(s);
      });
      let found = false;
      for (const monId of Object.keys(monSchedules)) {
        const monSlots = monSchedules[monId].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
        const startIndex = monSlots.findIndex(s => {
          const t = new Date(s.start_time).toLocaleTimeString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false });
          return t === p.time;
        });
        if (startIndex === -1) continue;
        const slotMs = new Date(monSlots[startIndex].end_time) - new Date(monSlots[startIndex].start_time);
        const baseDur = Math.round(slotMs / 60000) || 15;
        const slotsNeeded = Math.ceil(flightDur / baseDur);
        if (startIndex + slotsNeeded <= monSlots.length) {
          let valid = true;
          for (let i = 1; i < slotsNeeded; i++) {
            const gap = new Date(monSlots[startIndex + i].start_time) - new Date(monSlots[startIndex + i - 1].end_time);
            if (Math.abs(gap) > 60000) { valid = false; break; }
          }
          if (valid) { found = true; break; }
        }
      }
      if (!found) {
        client.release();
        return res.status(409).json({ error: `Le créneau ${p.time} du ${p.date} n'est plus disponible pour ${p.firstName}. Veuillez choisir un autre horaire.` });
      }
    }

    let originalPriceCents = flightTotalCents + complementsTotalCents;
    let discountAmountCents = 0;
    let appliedVoucher = null;
    let appliedPartner = null;

    if (partner_code) {
      const pRes = await client.query(`SELECT * FROM partners WHERE UPPER(code) = UPPER($1) AND is_active = true`, [partner_code]);
      if (pRes.rows.length > 0) {
        appliedPartner = pRes.rows[0];
        discountAmountCents = originalPriceCents; // 100% discount for partners
      }
    }

    if (!appliedPartner && voucher_code) {
      const vRes = await client.query(`SELECT * FROM gift_cards WHERE UPPER(code) = UPPER($1) AND status = 'valid'`, [voucher_code]);
      if (vRes.rows.length > 0) {
        appliedVoucher = vRes.rows[0];
        if (appliedVoucher.type === 'gift_card') {
          discountAmountCents = appliedVoucher.price_paid_cents;
        } else if (appliedVoucher.type === 'promo') {
          const scope = appliedVoucher.discount_scope || 'both';
          let targetAmountCents = originalPriceCents;

          if (scope === 'flight') targetAmountCents = flightTotalCents;
          if (scope === 'complements') targetAmountCents = complementsTotalCents;

          if (appliedVoucher.discount_type === 'fixed') discountAmountCents = Math.min(appliedVoucher.discount_value * 100, targetAmountCents);
          if (appliedVoucher.discount_type === 'percentage') discountAmountCents = Math.round(targetAmountCents * (appliedVoucher.discount_value / 100));
        }
      }
    }

    const finalPriceCents = Math.max(0, originalPriceCents - discountAmountCents);

    if (finalPriceCents === 0) {
      await client.query('BEGIN');
      let pData = null;
      if (appliedPartner) {
        pData = { partner: true, partner_id: appliedPartner.id, partner_name: appliedPartner.name, code: appliedPartner.code, partner_color: appliedPartner.color_code };
      } else if (appliedVoucher) {
        pData = { voucher: originalPriceCents, code: appliedVoucher.code, code_type: appliedVoucher.type };
        // Attribuer le bon cadeau au pilote qui le détient
        if (appliedVoucher.type === 'gift_card' && appliedVoucher.monitor_id) {
          pData.encaisseur_id = appliedVoucher.monitor_id;
        }
      }
      await performBooking(client, contact, passengers, pData);
      
      if (appliedVoucher) {
        await client.query(`UPDATE gift_cards SET current_uses = current_uses + 1, status = CASE WHEN max_uses IS NOT NULL AND (current_uses + 1) >= max_uses THEN 'used' ELSE status END WHERE id = $1`, [appliedVoucher.id]);
      }
      
      await client.query('COMMIT');
      
      if (passengers.length > 0) {
        const firstPass = passengers[0];
        const flightDateObj = new Date(firstPass.date);
        const beautifulDate = flightDateObj.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
        await sendConfirmationEmail(contact.email, `${contact.firstName} ${contact.lastName}`, 'flight', firstPass.flightName, beautifulDate, firstPass.time, firstPass.flightId);
        await sendConfirmationSMS(contact.phone, contact.firstName, 'flight', beautifulDate, firstPass.time, firstPass.flightId);
        await sendAdminNotificationEmail(`${contact.firstName} ${contact.lastName}`, contact.phone, firstPass.flightName, beautifulDate, firstPass.time);
      }
      return res.json({ url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/succes?session_id=GRATUIT_${Date.now()}&embed=true` });
    }

    const passengersJson = JSON.stringify(passengers);
    const metadata = {
      contact_name: `${contact.firstName} ${contact.lastName}`.substring(0, 500),
      contact_phone: contact.phone ? String(contact.phone).substring(0, 500) : '',
      contact_email: contact.email ? String(contact.email).substring(0, 500) : '',
      contact_notes: contact.notes ? contact.notes.substring(0, 450) : '',
      voucher_code: appliedVoucher ? appliedVoucher.code : '',
      voucher_type: appliedVoucher ? appliedVoucher.type : '',
      voucher_discount_cents: discountAmountCents ? discountAmountCents.toString() : '0'
    };

    const chunkSize = 500;
    for (let i = 0; i < passengersJson.length; i += chunkSize) {
      metadata[`passengers_chunk_${Math.floor(i / chunkSize)}`] = passengersJson.substring(i, i + chunkSize);
    }

    const sessionConfig = {
      payment_method_types: ['card'],
      customer_email: contact.email,
      line_items: line_items,
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/succes?session_id={CHECKOUT_SESSION_ID}&embed=true`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/booking?embed=true`,
      metadata: metadata 
    };

    if (appliedVoucher && discountAmountCents > 0) {
      const coupon = await stripe.coupons.create({ amount_off: discountAmountCents, currency: 'eur', duration: 'once', name: `Réduction (${appliedVoucher.code})` });
      sessionConfig.discounts = [{ coupon: coupon.id }];
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Erreur Checkout Stripe:", err);
    res.status(500).json({ error: "Erreur lors de l'initialisation du paiement." });
  } finally {
    client.release();
  }
});

// 🎯 SECURISE : CONFIRMATION DES PAIEMENTS (chemin redirect)
// Verrou mémoire — protection rapide contre les doubles appels concurrents
// (ex : React StrictMode appelle useEffect deux fois en dev).
// La protection principale contre les redémarrages/multi-instances est dans
// processStripeSession() via la table stripe_payments.
const activeCheckoutSessions = new Set();

router.post('/api/public/confirm-booking', confirmLimiter, async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: "Session ID manquant" });

  // Les paiements gratuits sont traités en amont — rien à confirmer ici
  if (session_id.startsWith('GRATUIT_')) return res.json({ success: true });

  // 🔒 Verrou mémoire : bloque les requêtes concurrentes sur la même instance
  if (activeCheckoutSessions.has(session_id)) {
    console.log("🛡️ Doublon concurrent bloqué (verrou mémoire) :", session_id);
    return res.json({ success: true, message: "Achat déjà en cours de traitement" });
  }
  activeCheckoutSessions.add(session_id);
  setTimeout(() => activeCheckoutSessions.delete(session_id), 3600000);

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      activeCheckoutSessions.delete(session_id);
      return res.status(400).json({ error: "Le paiement n'a pas abouti." });
    }

    // processStripeSession gère l'idempotence DB et tout le traitement
    const result = await processStripeSession(session);

    if (result === null) {
      // Déjà traité (par un webhook ou un appel précédent) — on relit le résultat
      const stored = await pool.query(
        'SELECT type, result_code FROM stripe_payments WHERE session_id = $1',
        [session_id]
      );
      const row = stored.rows[0];
      if (row?.type === 'gift_card') {
        return res.json({ success: true, is_gift_card: true, code: row.result_code });
      }
      if (row?.type === 'refunded') {
        return res.json({ success: false, refunded: true });
      }
      return res.json({ success: true });
    }

    return res.json(result);

  } catch (err) {
    activeCheckoutSessions.delete(session_id);
    console.error("❌ ERREUR CRITIQUE CONFIRMATION:", err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/api/public/download-gift-card/:code', confirmLimiter, async (req, res) => {
  const { code } = req.params;
  try {
    const voucherRes = await pool.query(`SELECT gc.*, ft.name as flight_name FROM gift_cards gc LEFT JOIN flight_types ft ON gc.flight_type_id = ft.id WHERE UPPER(gc.code) = UPPER($1)`, [code]);
    if (voucherRes.rows.length === 0) return res.status(404).send("Bon cadeau introuvable.");

    const pdfBuffer = await generatePDFBuffer(voucherRes.rows[0]);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Bon_Cadeau_${voucherRes.rows[0].code}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Erreur génération PDF:", err);
    if (!res.headersSent) res.status(500).send("Erreur lors de la génération du bon cadeau.");
  }
});


router.get('/api/ical/:id', async (req, res) => {
  try {
    const result = await generateICalFeed(pool, req.params.id);
    if (!result) return res.status(404).send('Moniteur introuvable');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="planning_fluide_${result.monitorName}.ics"`);
    res.send(result.ical);
  } catch (err) {
    console.error('Erreur génération iCal:', err);
    res.status(500).send('Erreur lors de la génération du calendrier');
  }
});


// ── Créneaux disponibles Aravis (remplace Firebase côté lecture) ──────────────
// Retourne { "YYYY-MM-DD": ["HH:MM", ...], ... } — même logique de filtres que
// /api/public/availabilities (périodes moniteur + Google Calendar sync).

router.get('/api/public/aravis/slots', availabilitiesLimiter, async (req, res) => {
  const { from, to, duration, flight_type_id } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Paramètres from et to requis (YYYY-MM-DD).' });
  const flightDuration = duration ? parseInt(duration, 10) : null;

  try {
    // Horaires autorisés et durée si flight_type_id fourni
    let allowedTimeSlots = [];
    let ftDuration = flightDuration;
    if (flight_type_id) {
      const ftRes = await pool.query(
        `SELECT duration_minutes, allowed_time_slots FROM flight_types WHERE id = $1 AND is_active = true`,
        [flight_type_id]
      );
      if (ftRes.rows.length > 0) {
        allowedTimeSlots = ftRes.rows[0].allowed_time_slots || [];
        if (!ftDuration && ftRes.rows[0].duration_minutes) ftDuration = ftRes.rows[0].duration_minutes;
      }
    }

    // Tous les créneaux de la période (disponibles uniquement)
    const { rows: rawSlots } = await pool.query(
      `SELECT id, start_time, end_time, status, monitor_id
       FROM slots
       WHERE status = 'available'
         AND start_time::date >= $1
         AND start_time::date <= $2
       ORDER BY start_time ASC`,
      [from, to]
    );

    // Périodes de disponibilité par moniteur
    const monitorIds = [...new Set(rawSlots.map(s => s.monitor_id).filter(Boolean))];
    const monitorAvailMap = {};
    if (monitorIds.length > 0) {
      const { rows: avRows } = await pool.query(
        `SELECT user_id,
                TO_CHAR(start_date, 'YYYY-MM-DD') AS start_date,
                TO_CHAR(end_date, 'YYYY-MM-DD') AS end_date
         FROM monitor_availabilities WHERE user_id = ANY($1)`,
        [monitorIds]
      );
      for (const row of avRows) {
        if (!monitorAvailMap[row.user_id]) monitorAvailMap[row.user_id] = [];
        monitorAvailMap[row.user_id].push(row);
      }
    }

    // Google Calendar sync
    const syncSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
    const isGoogleSyncEnabled = syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true';

    // { date: { heure: capacité } }
    const grouped = {};

    for (const slot of rawSlots) {
      const slotStart = new Date(slot.start_time);
      // Heure locale Paris (référence réelle du planning)
      const dateStr = slotStart.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
      const timeStr = slotStart.toLocaleTimeString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false });

      // Filtre durée minimale — on ne subdivise pas, on vérifie juste que le créneau est assez long
      if (ftDuration && !isNaN(ftDuration)) {
        const slotEnd = new Date(slot.end_time);
        const slotDurationMin = (slotEnd - slotStart) / 60000;
        if (slotDurationMin < ftDuration) continue;
      }

      // Filtre horaires autorisés (allowed_time_slots du type de vol)
      if (allowedTimeSlots.length > 0 && !allowedTimeSlots.includes(timeStr)) continue;

      // Filtre période moniteur
      const periods = monitorAvailMap[slot.monitor_id];
      if (periods?.length > 0) {
        const inPeriod = periods.some(p => dateStr >= p.start_date && dateStr <= p.end_date);
        if (!inPeriod) continue;
      }

      // Filtre Google Calendar
      if (isGoogleSyncEnabled && slot.monitor_id) {
        const googleBusy = googleSyncCache.get(slot.monitor_id) || [];
        const slotEnd = new Date(slot.end_time).getTime();
        const isBusy = googleBusy.some(g => slotStart.getTime() < g.end && slotEnd > g.start);
        if (isBusy) continue;
      }

      if (!grouped[dateStr]) grouped[dateStr] = {};
      grouped[dateStr][timeStr] = (grouped[dateStr][timeStr] || 0) + 1;
    }

    // Tri des heures dans chaque jour
    const result = {};
    for (const [date, times] of Object.entries(grouped)) {
      result[date] = Object.fromEntries(
        Object.entries(times).sort(([a], [b]) => a.localeCompare(b))
      );
    }

    res.json(result);
  } catch (err) {
    console.error('[Aravis slots]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── Demande de vol Aravis (endpoint public, sans authentification) ────────────

const aravisRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de demandes. Veuillez réessayer dans 10 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/api/public/aravis/request', aravisRequestLimiter, async (req, res) => {
  const { name, phone, email, nb_passengers, weight_info, flight_type, requested_date, requested_time, notes } = req.body;

  // Champ obligatoire minimal
  if (!name && !phone && !email) {
    return res.status(400).json({ error: 'Au moins un contact (nom, téléphone ou email) est requis.' });
  }

  // Texte de disponibilité lisible dans le backoffice
  const availabilityText = requested_time || null;
  const availabilityStart = requested_date || null;
  const availabilityEnd = requested_date || null;

  const notesWithFlight = [
    flight_type ? `Vol souhaité : ${flight_type}` : null,
    notes || null,
  ].filter(Boolean).join('\n') || null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO standby_clients
        (name, phone, email, nb_passengers, flight_type, weight_info,
         availability_text, availability_start, availability_end, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING id`,
      [
        name || null,
        phone || null,
        email || null,
        nb_passengers || 1,
        flight_type || null,
        weight_info || null,
        availabilityText,
        availabilityStart,
        availabilityEnd,
        notesWithFlight,
      ]
    );
    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    console.error('[Aravis request]', err);
    res.status(500).json({ error: 'Erreur serveur. Votre demande n\'a pas pu être enregistrée.' });
  }
});

module.exports = router;
