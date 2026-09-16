// migrate.js — Système de migrations SQL versionnées
// Chaque migration n'est exécutée QU'UNE SEULE FOIS, même après plusieurs redémarrages.

const db = require('./db');

const migrations = [
  {
    name: '001_gift_card_custom_lines',
    sql: `
      ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS custom_line_1 VARCHAR(255);
      ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS custom_line_2 VARCHAR(255);
      ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS custom_line_3 VARCHAR(255);
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS custom_line_1 VARCHAR(255);
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS custom_line_2 VARCHAR(255);
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS custom_line_3 VARCHAR(255);
      ALTER TABLE gift_card_templates ALTER COLUMN custom_line_1 TYPE VARCHAR(255);
      ALTER TABLE gift_card_templates ALTER COLUMN custom_line_2 TYPE VARCHAR(255);
      ALTER TABLE gift_card_templates ALTER COLUMN custom_line_3 TYPE VARCHAR(255);
      ALTER TABLE gift_cards ALTER COLUMN custom_line_1 TYPE VARCHAR(255);
      ALTER TABLE gift_cards ALTER COLUMN custom_line_2 TYPE VARCHAR(255);
      ALTER TABLE gift_cards ALTER COLUMN custom_line_3 TYPE VARCHAR(255);
    `
  },
  {
    name: '002_gift_cards_buyer_phone',
    sql: `ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS buyer_phone VARCHAR(50);`
  },
  {
    name: '003_pdf_background_url',
    sql: `
      ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS pdf_background_url VARCHAR(500);
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS pdf_background_url VARCHAR(500);
    `
  },
  {
    name: '004_gift_cards_partner_billing',
    sql: `
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS is_partner BOOLEAN DEFAULT false;
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS partner_amount_cents INTEGER;
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS partner_billing_type VARCHAR(50) DEFAULT 'fixed';
      ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS buyer_address TEXT;
    `
  },
  {
    name: '005_gift_card_templates_popup',
    sql: `
      ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS popup_content TEXT;
      ALTER TABLE gift_card_templates ADD COLUMN IF NOT EXISTS show_popup BOOLEAN DEFAULT false;
    `
  },
  {
    name: '006_flight_types_popup',
    sql: `
      ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS popup_content TEXT;
      ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS show_popup BOOLEAN DEFAULT false;
    `
  },
  {
    name: '007_monitor_availabilities',
    sql: `
      CREATE TABLE IF NOT EXISTS monitor_availabilities (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        daily_start_time TIME NOT NULL,
        daily_end_time TIME NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_monitor_availabilities_user_id ON monitor_availabilities(user_id);
    `
  },
  {
    name: '008_processed_stripe_sessions',
    sql: `
      CREATE TABLE IF NOT EXISTS processed_stripe_sessions (
        session_id VARCHAR(255) PRIMARY KEY,
        processed_at TIMESTAMP DEFAULT NOW()
      );
    `
  },
  {
    name: '009_slots_payment_data',
    sql: `ALTER TABLE slots ADD COLUMN IF NOT EXISTS payment_data JSONB;`
  },
  {
    name: '010_slots_drop_payment_status',
    sql: `ALTER TABLE slots DROP COLUMN IF EXISTS payment_status;`
  },
  {
    name: '011_stripe_payments',
    sql: `
      CREATE TABLE IF NOT EXISTS stripe_payments (
        session_id   TEXT PRIMARY KEY,
        type         TEXT NOT NULL,
        result_code  TEXT,
        processed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `
  },
  {
    name: '012_users_google_sync_enabled',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sync_enabled BOOLEAN NOT NULL DEFAULT false;`
  },
  {
    name: '013_flight_types_description',
    sql: `ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS description TEXT;`
  },
  {
    name: '014_flight_types_activities',
    sql: `
      ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS activity_ski BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS activity_snowboard BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS activity_pedestrian BOOLEAN NOT NULL DEFAULT false;
    `
  },
  {
    name: '015_flight_types_activity_children',
    sql: `ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS activity_children BOOLEAN NOT NULL DEFAULT false;`
  },
  {
    name: '016_flight_types_activity_gopro',
    sql: `ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS activity_gopro BOOLEAN NOT NULL DEFAULT false;`
  },
  {
    name: '018_commission_fields',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_type VARCHAR(20) NOT NULL DEFAULT 'none';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_value NUMERIC(10,2) NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS receives_online_payments BOOLEAN NOT NULL DEFAULT false;
    `
  },
  {
    name: '019_partners_commission',
    sql: `
      ALTER TABLE partners ADD COLUMN IF NOT EXISTS commission_type VARCHAR(20) NOT NULL DEFAULT 'none';
      ALTER TABLE partners ADD COLUMN IF NOT EXISTS commission_value NUMERIC(10,2) NOT NULL DEFAULT 0;
    `
  },
  {
    name: '020_partners_facturable',
    sql: `
      ALTER TABLE partners ADD COLUMN IF NOT EXISTS facturable BOOLEAN NOT NULL DEFAULT true;
    `
  },
  {
    name: '021_gift_cards_monitor_id',
    sql: `ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS monitor_id UUID REFERENCES users(id) ON DELETE SET NULL;`
  },
  {
    name: '022_partner_flight_types',
    sql: `
      CREATE TABLE IF NOT EXISTS partner_flight_types (
        partner_id     INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
        flight_type_id INTEGER NOT NULL REFERENCES flight_types(id) ON DELETE CASCADE,
        base_price_cents INTEGER,
        PRIMARY KEY (partner_id, flight_type_id)
      );
    `
  },
  {
    name: '023_standby_clients',
    sql: `
      CREATE TABLE IF NOT EXISTS standby_clients (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        phone VARCHAR(50),
        email VARCHAR(255),
        nb_passengers INTEGER DEFAULT 1,
        flight_type VARCHAR(100),
        weight_info VARCHAR(200),
        availability_text TEXT,
        availability_start DATE,
        availability_end DATE,
        notes TEXT,
        pilot_name VARCHAR(255),
        booked_date DATE,
        booked_time VARCHAR(10),
        slot_id INTEGER,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `
  },
  {
    name: '024_flight_types_media_included',
    sql: `ALTER TABLE flight_types ADD COLUMN IF NOT EXISTS media_included BOOLEAN NOT NULL DEFAULT false;`
  },
  {
    name: '025_slots_second_booking',
    sql: `ALTER TABLE slots ADD COLUMN IF NOT EXISTS second_booking JSONB DEFAULT NULL;`
  },
  {
    name: '026_users_phone',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30) DEFAULT NULL;`
  },
  {
    name: '017_partners_table',
    sql: `
      CREATE TABLE IF NOT EXISTS partners (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        code        VARCHAR(50)  UNIQUE NOT NULL,
        color_code  VARCHAR(7)   NOT NULL DEFAULT '#6366f1',
        booking_fields JSONB    NOT NULL DEFAULT '{"name":true,"phone":true,"email":true,"flight_type":true,"weight":false,"notes":false}',
        is_active   BOOLEAN      NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `
  },
  {
    name: '027_standby_soft_delete',
    sql: `ALTER TABLE standby_clients ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;`
  },
];

async function runMigrations() {
  // Création de la table de suivi si elle n'existe pas
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id     SERIAL PRIMARY KEY,
      name   VARCHAR(255) UNIQUE NOT NULL,
      run_at TIMESTAMP DEFAULT NOW()
    )
  `);

  let applied = 0;
  for (const migration of migrations) {
    const { rows } = await db.query(
      'SELECT id FROM _migrations WHERE name = $1',
      [migration.name]
    );

    if (rows.length === 0) {
      console.log(`▶  Migration : ${migration.name}`);
      await db.query(migration.sql);
      await db.query('INSERT INTO _migrations (name) VALUES ($1)', [migration.name]);
      console.log(`✅ Migration appliquée : ${migration.name}`);
      applied++;
    }
  }

  if (applied === 0) {
    console.log('✅ Base de données à jour — aucune migration à appliquer.');
  } else {
    console.log(`✅ ${applied} migration(s) appliquée(s) avec succès.`);
  }
}

module.exports = { runMigrations };
