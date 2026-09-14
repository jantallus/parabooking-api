// schemas/index.js
// Tous les schémas Zod du projet, organisés par domaine.

const { z } = require('zod');

// ── Helpers réutilisables ──────────────────────────────────────────────────────

const phoneRegex = /^[+\d\s()./-]{6,20}$/;
const dateRegex  = /^\d{4}-\d{2}-\d{2}$/;
const timeRegex  = /^\d{2}:\d{2}$/;

const zPhone = z.string().regex(phoneRegex, 'Numéro de téléphone invalide').max(20);
const zDate  = z.string().regex(dateRegex,  'Date invalide (format attendu : YYYY-MM-DD)');
const zTime  = z.string().regex(timeRegex,  'Heure invalide (format attendu : HH:MM)');
const zEmail = z.string().email('Email invalide').max(200);
const zName  = z.string().min(1, 'Champ requis').max(100).trim();

// Accepte une date/heure valide, une chaîne vide ou null — coerce '' en null
const zDateOpt = z.union([zDate, z.literal(''), z.null()]).optional().transform(v => v || null);
const zTimeOpt = z.union([zTime, z.literal(''), z.null()]).optional().transform(v => v || null);


// ── PUBLIC : Réservation de vol ───────────────────────────────────────────────

const PassengerSchema = z.object({
  firstName:            zName,
  flightId:             z.coerce.number().int().positive(), // le frontend envoie parfois une string (clé de panier)
  flightName:           z.string().max(200).optional(),
  date:                 zDate,
  time:                 zTime,
  weight:               z.number().int().min(10).max(250).optional().nullable(),
  selectedComplements:  z.array(z.number().int().positive()).max(10).optional(),
});

const CheckoutSchema = z.object({
  contact: z.object({
    firstName:  zName,
    lastName:   z.string().max(100).trim().optional().default(''),
    email:      zEmail,
    phone:      zPhone.optional().or(z.literal('')),
    notes:      z.string().max(500).optional().default(''),
  }),
  passengers:   z.array(PassengerSchema).min(1, 'Au moins un passager requis').max(10),
  voucher_code: z.string().max(50).trim().nullish(), // null envoyé par le frontend quand aucun bon appliqué
  partner_code: z.string().max(50).trim().nullish(),
});


// ── PUBLIC : Achat bon cadeau ─────────────────────────────────────────────────

const CheckoutGiftCardSchema = z.object({
  template: z.object({
    id: z.number().int().positive(),
  }),
  buyer: z.object({
    name:  zName,
    email: zEmail,
    phone: zPhone.optional().or(z.literal('')),
  }),
  physicalShipping: z.object({
    enabled: z.boolean(),
    address: z.string().max(500).optional(),
  }).nullish(), // le frontend envoie null quand la livraison physique n'est pas souhaitée
  selectedComplements: z.array(z.object({
    id: z.number().int().positive(),
  })).max(10).optional(),
});


// ── ADMIN : Utilisateurs ──────────────────────────────────────────────────────

const CreateUserSchema = z.object({
  first_name:               zName,
  email:                    zEmail,
  phone:                    z.string().max(30).optional().nullable(),
  password:                 z.string().min(8, 'Mot de passe trop court (8 caractères minimum)').max(200),
  role:                     z.enum(['admin', 'monitor', 'permanent', 'aravis']),
  enseigne:                 z.enum(['fluide', 'aravis']).optional().default('fluide'),
  is_active_monitor:        z.boolean().optional().default(false),
  google_sync_enabled:      z.boolean().optional().default(false),
  receives_online_payments: z.boolean().optional().default(false),
  commission_type:          z.enum(['none', 'percentage', 'fixed']).optional().default('none'),
  commission_value:         z.number().min(0).max(100000).optional().default(0),
  available_start_date:     zDateOpt,
  available_end_date:       zDateOpt,
  daily_start_time:         zTimeOpt,
  daily_end_time:           zTimeOpt,
  notify_on_request:        z.boolean().optional().default(false),
  request_notification_sms: z.string().max(500).optional().nullable(),
});

const UpdateUserSchema = z.object({
  first_name:               zName.optional(),
  email:                    zEmail.optional(),
  phone:                    z.string().max(30).optional().nullable(),
  password:                 z.string().min(8).max(200).optional(),
  role:                     z.enum(['admin', 'monitor', 'permanent', 'aravis']).optional(),
  enseigne:                 z.enum(['fluide', 'aravis']).optional(),
  is_active_monitor:        z.boolean().optional(),
  google_sync_enabled:      z.boolean().optional(),
  receives_online_payments: z.boolean().optional(),
  commission_type:          z.enum(['none', 'percentage', 'fixed']).optional(),
  commission_value:         z.number().min(0).max(100000).optional(),
  status:                   z.enum(['Actif', 'Inactif']).optional(),
  available_start_date:     zDateOpt,
  available_end_date:       zDateOpt,
  daily_start_time:         zTimeOpt,
  daily_end_time:           zTimeOpt,
  notify_on_request:        z.boolean().optional(),
  request_notification_sms: z.string().max(500).optional().nullable(),
});


// ── ADMIN : Types de vol ──────────────────────────────────────────────────────

const FlightTypeSchema = z.object({
  name:                   z.string().min(1).max(100),
  description:            z.string().max(1000).optional().nullable(),
  activity_ski:           z.boolean().optional().default(false),
  activity_snowboard:     z.boolean().optional().default(false),
  activity_pedestrian:    z.boolean().optional().default(false),
  activity_children:      z.boolean().optional().default(false),
  activity_gopro:         z.boolean().optional().default(false),
  duration_minutes:       z.number().int().min(1).max(480),
  price_cents:            z.number().int().min(0).max(1000000),
  restricted_start_time:  zTime.optional().nullable().or(z.literal('')),
  restricted_end_time:    zTime.optional().nullable().or(z.literal('')),
  color_code:             z.string().max(20).optional(),
  allowed_time_slots:     z.array(zTime).optional(),
  season:                 z.string().max(50).optional().default('Standard'),
  allow_multi_slots:      z.boolean().optional().default(false),
  weight_min:             z.number().int().min(0).max(200).optional().default(20),
  weight_max:             z.number().int().min(0).max(500).optional().default(110),
  booking_delay_hours:    z.number().int().min(0).max(720).optional().default(0),
  image_url:              z.string().url().max(500).optional().nullable().or(z.literal('')),
  popup_content:          z.string().max(2000).optional().nullable(),
  show_popup:             z.boolean().optional().default(false),
  media_included:         z.boolean().optional().default(false),
  passengers_per_slot:    z.number().int().min(1).max(20).optional().default(1),
  tenant:                 z.enum(['fluide', 'aravis']).optional(),
});


// ── ADMIN : Bons cadeaux ──────────────────────────────────────────────────────

const CreateGiftCardSchema = z.object({
  flight_type_id:        z.number().int().positive().optional().nullable(),
  buyer_name:            z.string().max(200).optional().nullable(),
  beneficiary_name:      z.string().max(200).optional().nullable(),
  price_paid_cents:      z.number().int().min(0).optional().default(0),
  notes:                 z.string().max(1000).optional().default(''),
  type:                  z.enum(['gift_card', 'promo']).optional().default('gift_card'),
  discount_type:         z.enum(['fixed', 'percentage']).optional().nullable(),
  discount_value:        z.number().min(0).optional().nullable(),
  custom_code:           z.string().max(50).optional().nullable(),
  max_uses:              z.number().int().min(1).optional().nullable(),
  valid_from:            zDate.optional().nullable(),
  valid_until:           zDate.optional().nullable(),
  discount_scope:        z.enum(['both', 'flight', 'complements']).optional().default('both'),
  is_partner:            z.boolean().optional().default(false),
  partner_amount_cents:  z.number().int().min(0).optional().nullable(),
  partner_billing_type:  z.enum(['fixed', 'percentage']).optional().default('fixed'),
});


// ── PLANNING : Patch quick ────────────────────────────────────────────────────

const QuickPatchSchema = z.object({
  payment_data:    z.record(z.unknown()).optional(),
  monitor_id:      z.union([z.number().int().positive(), z.string(), z.null()]).optional(),
  billing_name:    z.string().max(200).trim().optional().nullable(),
  booking_options: z.string().max(500).optional().nullable(),
}).strict(); // Interdit les champs non déclarés


module.exports = {
  CheckoutSchema,
  CheckoutGiftCardSchema,
  CreateUserSchema,
  UpdateUserSchema,
  FlightTypeSchema,
  CreateGiftCardSchema,
  QuickPatchSchema,
};
