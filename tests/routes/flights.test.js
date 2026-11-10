// tests/routes/flights.test.js
// Tests d'intégration des routes flight-types et compléments.

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../db', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('stripe', () => () => ({
  checkout: { sessions: { create: jest.fn() } },
}));
jest.mock('../../services/email', () => ({
  sendConfirmationEmail:      jest.fn(),
  sendAdminNotificationEmail: jest.fn(),
  notifyGoogleCalendar:       jest.fn(),
}));
jest.mock('../../services/sentry', () => ({
  initSentry:            () => {},
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

// ── Setup ──────────────────────────────────────────────────────────────────────

const request  = require('supertest');
const jwt      = require('jsonwebtoken');
const { pool } = require('../../db');

let app;
beforeAll(() => { app = require('../../app'); });
beforeEach(() => { jest.resetAllMocks(); });

const JWT_SECRET = process.env.JWT_SECRET;
const adminToken = () => jwt.sign({ id: 1, role: 'admin', email: 'a@test.com' }, JWT_SECRET, { expiresIn: '1h' });

const VALID_FLIGHT = {
  name: 'Vol Découverte',
  duration_minutes: 15,
  price_cents: 9900,
};

// ── GET /api/flight-types ─────────────────────────────────────────────────────

describe('GET /api/flight-types', () => {
  it('retourne 200 sans authentification (route publique)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Vol Découverte', price_cents: 9900 }] });

    const res = await request(app).get('/api/flight-types');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].name).toBe('Vol Découverte');
  });

  it('retourne un tableau vide si aucun vol configuré', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/flight-types');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── POST /api/flight-types ────────────────────────────────────────────────────

describe('POST /api/flight-types', () => {
  it('retourne 401 sans token', async () => {
    const res = await request(app).post('/api/flight-types').send(VALID_FLIGHT);
    expect(res.status).toBe(401);
  });

  it('retourne 400 si Zod invalide (name manquant)', async () => {
    const res = await request(app)
      .post('/api/flight-types')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ duration_minutes: 15, price_cents: 9900 }); // name absent

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Données invalides/);
  });

  it('retourne 400 si price_cents est négatif', async () => {
    const res = await request(app)
      .post('/api/flight-types')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ...VALID_FLIGHT, price_cents: -100 });

    expect(res.status).toBe(400);
  });

  it('crée un type de vol et retourne la ligne insérée', async () => {
    const created = { id: 5, ...VALID_FLIGHT };
    pool.query.mockResolvedValueOnce({ rows: [created] });

    const res = await request(app)
      .post('/api/flight-types')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send(VALID_FLIGHT);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(5);
    expect(res.body.name).toBe('Vol Découverte');
  });

  it('convertit une restricted_start_time vide en null', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 6, ...VALID_FLIGHT }] });

    await request(app)
      .post('/api/flight-types')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ...VALID_FLIGHT, restricted_start_time: '' });

    const insertCall = pool.query.mock.calls.find(c => c[0].includes('INSERT INTO flight_types'));
    const params = insertCall[1];
    const columns = insertCall[0].match(/INSERT INTO flight_types \(([^)]+)\)/)[1].split(',').map(c => c.trim());
    expect(params[columns.indexOf('restricted_start_time')]).toBeNull();
  });
});

// ── PUT /api/flight-types/:id ─────────────────────────────────────────────────

describe('PUT /api/flight-types/:id', () => {
  it('retourne 401 sans token', async () => {
    const res = await request(app).put('/api/flight-types/1').send(VALID_FLIGHT);
    expect(res.status).toBe(401);
  });

  it('met à jour le type de vol et retourne success', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/api/flight-types/1')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send(VALID_FLIGHT);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ── DELETE /api/flight-types/:id ──────────────────────────────────────────────

describe('DELETE /api/flight-types/:id', () => {
  it('retourne 401 sans token', async () => {
    const res = await request(app).delete('/api/flight-types/1');
    expect(res.status).toBe(401);
  });

  it('supprime le type de vol et retourne success', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .delete('/api/flight-types/1')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('retourne 500 si le vol est utilisé (contrainte FK)', async () => {
    pool.query.mockRejectedValueOnce(new Error('violates foreign key constraint'));

    const res = await request(app)
      .delete('/api/flight-types/1')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Impossible de supprimer/);
  });
});

// ── GET /api/complements ──────────────────────────────────────────────────────

describe('GET /api/complements', () => {
  it('retourne 200 sans authentification (route publique)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Photos', price_cents: 2000, is_active: true }] });

    const res = await request(app).get('/api/complements');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── POST /api/complements ─────────────────────────────────────────────────────

describe('POST /api/complements', () => {
  it('retourne 401 sans token', async () => {
    const res = await request(app).post('/api/complements').send({ name: 'Photos', price_cents: 2000 });
    expect(res.status).toBe(401);
  });

  it('crée un complément et retourne la ligne insérée', async () => {
    const created = { id: 3, name: 'Photos', price_cents: 2000, is_active: true };
    pool.query.mockResolvedValueOnce({ rows: [created] });

    const res = await request(app)
      .post('/api/complements')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Photos', description: 'Pack photos HD', price_cents: 2000 });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Photos');
  });
});

// ── DELETE /api/complements/:id ───────────────────────────────────────────────

describe('DELETE /api/complements/:id', () => {
  it('retourne 401 sans token', async () => {
    const res = await request(app).delete('/api/complements/1');
    expect(res.status).toBe(401);
  });

  it('supprime le complément et retourne success', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .delete('/api/complements/1')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
