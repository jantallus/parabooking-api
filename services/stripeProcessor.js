// services/stripeProcessor.js
// Logique partagée entre la route confirm-booking (redirect) et le webhook Stripe.
// Les deux chemins doivent produire exactement le même résultat pour une session donnée.

const { randomUUID } = require('crypto');
const Stripe = require('stripe');
const { pool } = require('../db');
const { performBooking } = require('./booking');
const { generatePDFBuffer } = require('./pdf');
const { sendConfirmationEmail, sendConfirmationSMS, sendAdminNotificationEmail } = require('./email');

/**
 * Traite une Checkout Session Stripe déjà payée (payment_status === 'paid').
 * Idempotent : si la session est déjà dans stripe_payments, renvoie le résultat stocké sans rien refaire.
 *
 * @param {object} session — objet Session Stripe (stripe.checkout.sessions.retrieve ou webhook event.data.object)
 * @returns {{ success: true, is_gift_card?: true, code?: string } | null}
 *          null si déjà traité (l'appelant peut logger mais ne doit pas re-notifier)
 */
async function processStripeSession(session) {
  const session_id = session.id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── Verrou persistant ─────────────────────────────────────────────────────
    // Vérifie si cette session a déjà été traitée (survit aux redémarrages + multi-instances)
    const existing = await client.query(
      'SELECT type, result_code FROM stripe_payments WHERE session_id = $1',
      [session_id]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      console.log(`🛡️ Session déjà traitée (stripe_payments) : ${session_id}`);
      const row = existing.rows[0];
      // On renvoie null pour signaler "déjà traité" — pas de re-notification
      return null;
    }

    // ── CAS 1 : ACHAT BON CADEAU ──────────────────────────────────────────────
    if (session.metadata.purchase_type === 'gift_card') {
      const finalCode = `FLUIDE-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

      const validUntil = new Date();
      const parsedMonths = parseInt(session.metadata.validity_months);
      const monthsToAdd = isNaN(parsedMonths) ? 12 : parsedMonths;
      validUntil.setMonth(validUntil.getMonth() + monthsToAdd);

      let finalNotes = session.metadata.notes || '';
      if (session.metadata.buyer_address) {
        finalNotes = `📮 À POSTER : ${session.metadata.buyer_address}\n` + finalNotes;
      }

      await client.query(
        `INSERT INTO gift_cards
           (code, flight_type_id, buyer_name, buyer_phone, beneficiary_name,
            price_paid_cents, type, status, discount_scope, valid_until,
            notes, pdf_background_url, buyer_address,
            custom_line_1, custom_line_2, custom_line_3)
         VALUES ($1,$2,$3,$4,'',$5,'gift_card','valid','both',$6,$7,$8,$9,$10,$11,$12)`,
        [
          finalCode,
          session.metadata.flight_type_id ? parseInt(session.metadata.flight_type_id) : null,
          session.metadata.buyer_name || 'Client Inconnu',
          session.metadata.buyer_phone || null,
          parseInt(session.metadata.price_paid_cents) || 0,
          validUntil,
          finalNotes,
          session.metadata.pdf_background_url || null,
          session.metadata.buyer_address || null,
          session.metadata.custom_line_1 || null,
          session.metadata.custom_line_2 || null,
          session.metadata.custom_line_3 || null,
        ]
      );

      // Enregistrement atomique dans le registre d'idempotence
      await client.query(
        'INSERT INTO stripe_payments (session_id, type, result_code) VALUES ($1, $2, $3)',
        [session_id, 'gift_card', finalCode]
      );

      await client.query('COMMIT');
      console.log(`✅ Bon cadeau créé : ${finalCode} (session ${session_id})`);

      // Notifications asynchrones (hors transaction)
      setImmediate(async () => {
        try {
          const isSpecific = !!session.metadata.flight_type_id;
          const pdfBuf = await generatePDFBuffer({
            code: finalCode,
            buyer_name: session.metadata.buyer_name,
            price_paid_cents: session.metadata.price_paid_cents,
            flight_name: isSpecific ? 'Vol en parapente' : null,
            pdf_background_url: session.metadata.pdf_background_url,
            custom_line_1: session.metadata.custom_line_1,
            custom_line_2: session.metadata.custom_line_2,
            custom_line_3: session.metadata.custom_line_3,
          });
          const flightLabel = isSpecific
            ? 'Vol en parapente'
            : `Avoir de ${(parseInt(session.metadata.price_paid_cents) || 0) / 100}€`;
          await sendConfirmationEmail(
            session.metadata.buyer_email,
            session.metadata.buyer_name,
            'gift_card',
            flightLabel,
            finalCode,
            '',
            null,
            pdfBuf
          );
        } catch (e) {
          console.error('❌ Erreur notifications Bon Cadeau:', e);
        }
      });

      return { success: true, is_gift_card: true, code: finalCode, amount_total: session.amount_total };
    }

    // ── CAS 2 : RÉSERVATION VOL ───────────────────────────────────────────────
    const contact = {
      phone: session.metadata.contact_phone || '',
      email: session.metadata.contact_email || '',
      notes: session.metadata.contact_notes || '',
    };

    // Infos de facturation (nom Stripe ou nom contact)
    const billingInfo = {
      billing_name: session.customer_details?.name || session.metadata.contact_name || null,
      billing_email: session.customer_details?.email || session.metadata.contact_email || null,
      group_id: randomUUID(),
    };

    // Recompose le JSON passagers depuis les chunks (500 chars / chunk)
    let passengersJson = '';
    let chunkIndex = 0;
    while (session.metadata[`passengers_chunk_${chunkIndex}`] !== undefined) {
      passengersJson += session.metadata[`passengers_chunk_${chunkIndex}`];
      chunkIndex++;
    }
    const passengers = JSON.parse(passengersJson);

    const voucherCode = session.metadata.voucher_code;
    const voucherType = session.metadata.voucher_type || 'promo';
    const pData = {
      online: true,
      cb: session.amount_total || 0,
      stripe_session_id: session.id,
      ...(voucherCode
        ? {
            code: voucherCode,
            code_type: voucherType,
            voucher: parseInt(session.metadata.voucher_discount_cents || '0'),
          }
        : {}),
    };

    // Récupérer les frais Stripe via la balance_transaction
    if (session.payment_intent && session.amount_total > 0) {
      try {
        const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
        const pi = await stripeClient.paymentIntents.retrieve(session.payment_intent, {
          expand: ['latest_charge.balance_transaction'],
        });
        const bt = pi.latest_charge?.balance_transaction;
        if (bt && typeof bt === 'object') {
          pData.stripe_fee_cents = bt.fee;
          pData.stripe_net_cents = bt.net;
        }
      } catch (e) {
        console.error('Stripe balance_transaction non disponible:', e.message);
      }
    }

    // Attribuer l'encaisseur : pilote du bon cadeau ou pilote configuré pour les paiements en ligne
    if (voucherCode && voucherType === 'gift_card') {
      const gcRes = await client.query('SELECT monitor_id FROM gift_cards WHERE UPPER(code) = UPPER($1)', [voucherCode]);
      if (gcRes.rows[0]?.monitor_id) pData.encaisseur_id = gcRes.rows[0].monitor_id;
    }
    if (!pData.encaisseur_id) {
      const onlineRes = await client.query('SELECT id FROM users WHERE receives_online_payments = true LIMIT 1');
      if (onlineRes.rows[0]) pData.encaisseur_id = onlineRes.rows[0].id;
    }

    try {
      await performBooking(client, contact, passengers, pData, billingInfo);
    } catch (bookingErr) {
      await client.query('ROLLBACK');

      // Remboursement automatique : le client a payé mais les créneaux ne sont plus dispo
      if (session.payment_intent && session.amount_total > 0) {
        try {
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          await stripe.refunds.create({
            payment_intent: session.payment_intent,
            metadata: { reason: 'creneaux_indisponibles', detail: bookingErr.message.substring(0, 500) },
          });
          console.log(`💰 Remboursement automatique émis pour session ${session_id} : ${bookingErr.message}`);
        } catch (refundErr) {
          console.error(`❌ ECHEC REMBOURSEMENT pour ${session_id} — intervention manuelle requise :`, refundErr.message);
        }
        // Marque comme remboursé pour éviter un double traitement
        try {
          await pool.query(
            'INSERT INTO stripe_payments (session_id, type) VALUES ($1, $2) ON CONFLICT (session_id) DO NOTHING',
            [session_id, 'refunded']
          );
        } catch (_) {}
        // Alerte admin
        try {
          await sendAdminNotificationEmail(
            session.metadata.contact_name || '?',
            session.metadata.contact_phone || '?',
            session.metadata.contact_email || '?',
            `⚠️ REMBOURSEMENT AUTO — créneaux indisponibles (${bookingErr.message})`,
            '—', '—'
          );
        } catch (_) {}
      }

      return { success: false, refunded: true, error: bookingErr.message };
    }

    if (voucherCode) {
      await client.query(
        `UPDATE gift_cards
         SET current_uses = current_uses + 1,
             status = CASE WHEN max_uses IS NOT NULL AND (current_uses + 1) >= max_uses THEN 'used' ELSE status END
         WHERE UPPER(code) = UPPER($1)`,
        [voucherCode]
      );
    }

    // Enregistrement atomique dans le registre d'idempotence
    await client.query(
      'INSERT INTO stripe_payments (session_id, type) VALUES ($1, $2)',
      [session_id, 'flight']
    );

    await client.query('COMMIT');
    console.log(`✅ Vol réservé (session ${session_id})`);

    // Notifications asynchrones (hors transaction)
    setImmediate(async () => {
      try {
        if (passengers.length > 0) {
          const firstPass = passengers[0];
          const beautifulDate = new Date(firstPass.date).toLocaleDateString('fr-FR', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          });

          // Résolution des noms de compléments (photos/vidéos etc.)
          const allCompIds = [...new Set(passengers.flatMap(p => p.selectedComplements || []))];
          let complementSummary = '';
          if (allCompIds.length > 0) {
            const compRes = await pool.query('SELECT id, name FROM complements WHERE id = ANY($1)', [allCompIds]);
            const compMap = Object.fromEntries(compRes.rows.map(r => [r.id, r.name]));
            const compCounts = {};
            passengers.forEach(p => {
              (p.selectedComplements || []).forEach(id => {
                const name = compMap[id] || `Option #${id}`;
                compCounts[name] = (compCounts[name] || 0) + 1;
              });
            });
            complementSummary = Object.entries(compCounts).map(([name, count]) => `${name} × ${count}`).join(', ');
          }

          // Groupe les passagers par vol+horaire et récupère les prix
          const uniqueFlightIds = [...new Set(passengers.map(p => parseInt(p.flightId)))];
          const priceRes = await pool.query('SELECT id, price_cents FROM flight_types WHERE id = ANY($1)', [uniqueFlightIds]);
          const priceMap = Object.fromEntries(priceRes.rows.map(r => [r.id, r.price_cents]));
          const groupMap = {};
          passengers.forEach(p => {
            const key = `${p.flightId}|${p.time}`;
            if (!groupMap[key]) groupMap[key] = { flightId: parseInt(p.flightId), flightName: p.flightName, time: p.time, count: 0 };
            groupMap[key].count++;
          });
          const flightLines = Object.values(groupMap)
            .sort((a, b) => a.time.localeCompare(b.time))
            .map(g => ({ name: g.flightName, count: g.count, time: g.time, totalCents: (priceMap[g.flightId] || 0) * g.count }));

          await sendConfirmationEmail(contact.email, session.metadata.contact_name, 'flight', firstPass.flightName, beautifulDate, firstPass.time, firstPass.flightId, null, flightLines);
          for (const line of flightLines) {
            await sendConfirmationSMS(contact.phone, session.metadata.contact_name, 'flight', beautifulDate, line.time, line.flightId, line);
          }
          await sendAdminNotificationEmail(session.metadata.contact_name, contact.phone, contact.email, firstPass.flightName, beautifulDate, firstPass.time, passengers.length, complementSummary, flightLines);
        }
      } catch (e) {
        console.error('❌ Erreur notifications Vol:', e);
      }
    });

    return { success: true, amount_total: session.amount_total };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { processStripeSession };
