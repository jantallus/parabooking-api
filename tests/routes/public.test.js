// tests/routes/public.test.js
// Tests d'intégration des routes publiques (Zod, logique métier, Stripe).
// La DB et Stripe sont mockés — aucune connexion réseau réelle.

// ── Mocks (hoistés par Jest avant les require) ────────────────────────────────

jest.mock('../../db', () => ({
  pool: {
    query:   jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock('stripe', () => () => ({
  checkout: {
    sessions: {
      create: jest.fn().mockResolvedValue({ url: 'https://stripe.com/c/pay/test' }),
    },
  },
  coupons: {
    create: jest.fn().mockResolvedValue({ id: 'coupon_test' }),
  },
}));

jest.mock('../../services/email', () => ({
  sendConfirmationEmail:      jest.fn().mockResolvedValue(true),
  sendConfirmationSMS:        jest.fn().mockResolvedValue(true),
  sendAdminNotificationEmail: jest.fn().mockResolvedValue(true),
  notifyGoogleCalendar:       jest.fn(),
}));

jest.mock('../../services/sentry', () => ({
  initSentry:           () => {},
  sentryErrorMiddleware: (err, req, res, next) => next(err),
}));

jest.mock('../../services/googleSync', () => ({ googleSyncCache: new Map() }));
jest.mock('../../services/ical',       () => ({ generateICalFeed: jest.fn() }));
jest.mock('../../services/pdf',        () => ({
  generatePDFBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf')),
  drawBackground:    jest.fn(),
}));
jest.mock('../../routes/webhook', () => {
  const express = require('express');
  return express.Router();
});

// ── Supertest setup ───────────────────────────────────────────────────────────

const request = require('supertest');
const { pool }  = require('../../db');

// L'app est importée APRÈS les mocks
let app;
beforeAll(() => { app = require('../../app'); });

// ── Helpers mock DB ───────────────────────────────────────────────────────────

function setupCheckoutMocks() {
  // pool.connect() → retourne un faux client
  const fakeClient = {
    query:   jest.fn(),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(fakeClient);

  fakeClient.query.mockImplementation(async (sql) => {
    if (sql.includes('max_passengers_per_booking')) return { rows: [] };
    if (sql.includes('flight_types'))               return { rows: [{ id: 1, name: 'Découverte', price_cents: 9500 }] };
    if (sql.includes('complements'))                return { rows: [] };
    if (sql.includes('gift_cards'))                 return { rows: [] };
    if (sql.includes('BEGIN') || sql.includes('COMMIT')) return { rows: [] };
    if (sql.includes('site_settings'))              return { rows: [] };
    // Créneau libre à 10:00 heure de Paris le 2026-06-15 (UTC+2 en été)
    if (sql.includes('FROM slots')) return { rows: [{
      id: 1, monitor_id: 2, status: 'available',
      start_time: new Date('2026-06-15T08:00:00Z'), end_time: new Date('2026-06-15T08:15:00Z'),
    }] };
    return { rows: [] };
  });

  // pool.query() pour le max_passengers check (avant pool.connect)
  pool.query.mockResolvedValue({ rows: [] });

  return fakeClient;
}

const validCheckoutBody = {
  contact: {
    firstName: 'Jean',
    lastName:  'Dupont',
    email:     'jean@test.com',
    phone:     '0612345678',
  },
  passengers: [{
    firstName: 'Marie',
    flightId:  1,
    date:      '2026-06-15',
    time:      '10:00',
  }],
};

// ── Tests POST /api/public/checkout ──────────────────────────────────────────

describe('POST /api/public/checkout', () => {

  it('retourne 400 si le body est vide', async () => {
    const res = await request(app).post('/api/public/checkout').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Données invalides/);
  });

  it('retourne 400 si email invalide', async () => {
    const res = await request(app).post('/api/public/checkout').send({
      ...validCheckoutBody,
      contact: { ...validCheckoutBody.contact, email: 'pas-un-email' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('retourne 400 si aucun passager', async () => {
    const res = await request(app).post('/api/public/checkout').send({
      ...validCheckoutBody,
      passengers: [],
    });
    expect(res.status).toBe(400);
  });

  it('retourne 400 si date mal formatée', async () => {
    const res = await request(app).post('/api/public/checkout').send({
      ...validCheckoutBody,
      passengers: [{ firstName: 'M', flightId: 1, date: '15/06/2026', time: '10:00' }],
    });
    expect(res.status).toBe(400);
  });

  it('retourne une URL Stripe si le body est valide', async () => {
    setupCheckoutMocks();
    const res = await request(app).post('/api/public/checkout').send(validCheckoutBody);
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('stripe');
  });
});

// ── Tests POST /api/public/checkout-gift-card ─────────────────────────────────

describe('POST /api/public/checkout-gift-card', () => {

  it('retourne 400 si template.id manquant', async () => {
    const res = await request(app).post('/api/public/checkout-gift-card').send({
      template: {},
      buyer: { name: 'Paul', email: 'paul@test.com' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Données invalides/);
  });

  it('retourne 400 si email acheteur invalide', async () => {
    const res = await request(app).post('/api/public/checkout-gift-card').send({
      template: { id: 1 },
      buyer: { name: 'Paul', email: 'nope' },
    });
    expect(res.status).toBe(400);
  });

  it('retourne 400 si plus de 10 compléments', async () => {
    const res = await request(app).post('/api/public/checkout-gift-card').send({
      template: { id: 1 },
      buyer: { name: 'Paul', email: 'paul@test.com' },
      selectedComplements: Array(11).fill({ id: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it('ne bloque pas un bon cadeau valide (Zod passe)', async () => {
    pool.query.mockResolvedValue({
      rows: [{ id: 1, title: 'Vol Découverte', price_cents: 9500, validity_months: 12, is_published: true }]
    });

    const res = await request(app).post('/api/public/checkout-gift-card').send({
      template: { id: 1 },
      buyer: { name: 'Paul Martin', email: 'paul@test.com' },
    });
    // Zod valide → la route continue (peut échouer en DB mock mais pas en 400 Zod)
    expect(res.status).not.toBe(400);
  });
});

// ── Tests POST /api/public/confirm-booking ────────────────────────────────────

describe('POST /api/public/confirm-booking', () => {

  it('retourne 400 si session_id manquant', async () => {
    const res = await request(app).post('/api/public/confirm-booking').send({});
    expect(res.status).toBe(400);
  });

  it('retourne 200 immédiatement pour un paiement gratuit', async () => {
    const res = await request(app)
      .post('/api/public/confirm-booking')
      .send({ session_id: 'GRATUIT_1234567890' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
