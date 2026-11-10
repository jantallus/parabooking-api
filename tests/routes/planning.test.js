// tests/routes/planning.test.js
// Tests d'intégration des routes planning (slots, quick-patch, auth par rôle).

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
beforeEach(() => {
  jest.resetAllMocks();
  pool.connect.mockResolvedValue({
    query:   jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  });
});

const JWT_SECRET     = process.env.JWT_SECRET;
const adminToken     = () => jwt.sign({ id: 1,  role: 'admin',     email: 'a@test.com' }, JWT_SECRET, { expiresIn: '1h' });
const monitorToken   = () => jwt.sign({ id: 2,  role: 'monitor',   email: 'm@test.com' }, JWT_SECRET, { expiresIn: '1h' });
const permanentToken = () => jwt.sign({ id: 3,  role: 'permanent', email: 'p@test.com' }, JWT_SECRET, { expiresIn: '1h' });

// ── GET /api/slots ─────────────────────────────────────────────────────────────

describe('GET /api/slots', () => {
  it('retourne 401 sans token', async () => {
    expect((await request(app).get('/api/slots')).status).toBe(401);
  });

  it('retourne 200 avec un token valide', async () => {
    pool.query.mockImplementation(async (sql) =>
      sql.startsWith('SELECT * FROM slots')
        ? { rows: [{ id: 1, status: 'available', monitor_id: '2' }] }
        : { rows: [] }
    );

    const res = await request(app)
      .get('/api/slots')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('filtre par monitor_id quand le rôle est monitor', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // slots (filtrés)
      .mockResolvedValueOnce({ rows: [] }); // google_sync setting

    await request(app)
      .get('/api/slots')
      .set('Authorization', `Bearer ${monitorToken()}`);

    const slotQuery = pool.query.mock.calls[0][0];
    expect(slotQuery).toContain('monitor_id');
  });
});

// ── PATCH /api/slots/:id — contrôle des rôles ─────────────────────────────────

describe('PATCH /api/slots/:id — contrôle des rôles', () => {
  it('retourne 403 si le rôle est monitor (lecture seule)', async () => {
    const res = await request(app)
      .patch('/api/slots/1')
      .set('Authorization', `Bearer ${monitorToken()}`)
      .send({ title: 'Jean Dupont', status: 'booked' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/lecture seule/);
  });

  it('retourne 403 si un permanent tente de modifier le slot d\'un autre monitor', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ monitor_id: '99', title: null, status: 'available' }] // slot appartient à monitor 99
    });

    const res = await request(app)
      .patch('/api/slots/1')
      .set('Authorization', `Bearer ${permanentToken()}`) // id = 3
      .send({ notes: 'Ma note', status: 'available', title: 'NOTE' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/votre propre planning/);
  });

  it('préfixe NON DISPO avec "(Admin)" quand l\'admin bloque', async () => {
    pool.query.mockImplementation(async (sql) =>
      sql.includes('UPDATE slots')
        ? { rows: [{ id: 1, status: 'booked', title: 'NON DISPO (Admin)', monitor_id: '2' }] }
        : { rows: [] }
    );

    const res = await request(app)
      .patch('/api/slots/1')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ title: 'NON DISPO', status: 'booked' });

    expect(res.status).toBe(200);
    // Vérifie que le titre envoyé à la DB contient "(Admin)"
    const updateCall = pool.query.mock.calls.find(c => c[0].includes('UPDATE slots'));
    expect(updateCall[1][0]).toBe('NON DISPO (Admin)');
  });

  it('préfixe ☕ PAUSE avec "(Admin)" quand l\'admin pose une pause', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, status: 'available', title: '☕ PAUSE (Admin)', monitor_id: '2' }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .patch('/api/slots/1')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ title: '☕ PAUSE', status: 'booked' });

    const updateCall = pool.query.mock.calls.find(c => c[0].includes('UPDATE slots'));
    expect(updateCall[1][0]).toBe('☕ PAUSE (Admin)');
  });

  it('retourne 404 si le slot n\'existe pas', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // UPDATE RETURNING vide → slot introuvable
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch('/api/slots/9999')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ title: 'Test', status: 'booked' });

    expect(res.status).toBe(404);
  });
});

// ── PATCH /api/slots/:id/quick — Zod + logique métier ─────────────────────────

describe('PATCH /api/slots/:id/quick', () => {
  it('retourne 401 sans token', async () => {
    expect((await request(app).patch('/api/slots/1/quick').send({ payment_data: {} })).status).toBe(401);
  });

  it('retourne 400 si un champ inconnu est envoyé (schéma strict)', async () => {
    const res = await request(app)
      .patch('/api/slots/1/quick')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ champ_pirate: 'valeur' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Données invalides/);
  });

  it('met à jour payment_data et retourne le slot', async () => {
    const fakeClient = {
      query:   jest.fn(),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValueOnce(fakeClient);

    fakeClient.query
      .mockResolvedValueOnce({ rows: [] })                                  // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, group_id: null, monitor_id: '2' }] }) // SELECT slot
      .mockResolvedValueOnce({ rows: [] })                                  // UPDATE payment_data
      .mockResolvedValueOnce({ rows: [] })                                  // COMMIT
      .mockResolvedValueOnce({ rows: [{ id: 1, payment_data: { cb: 9500 } }] }); // SELECT final

    const res = await request(app)
      .patch('/api/slots/1/quick')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ payment_data: { cb: 9500 } });

    expect(res.status).toBe(200);
  });

  it('propage billing_name à tous les slots du même group_id', async () => {
    const fakeClient = {
      query:   jest.fn(),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValueOnce(fakeClient);

    fakeClient.query
      .mockResolvedValueOnce({ rows: [] })                                               // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, group_id: 'uuid-grp', monitor_id: '2' }] }) // SELECT slot
      .mockResolvedValueOnce({ rows: [] })                                               // UPDATE billing par group_id
      .mockResolvedValueOnce({ rows: [] })                                               // COMMIT
      .mockResolvedValueOnce({ rows: [{ id: 1, billing_name: 'MARTIN Paul' }] });        // SELECT final

    await request(app)
      .patch('/api/slots/1/quick')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ billing_name: 'MARTIN Paul' });

    // Vérifie que la propagation par group_id a été effectuée
    const billingCall = fakeClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('billing_name') && c[0].includes('group_id')
    );
    expect(billingCall).toBeDefined();
    expect(billingCall[1][0]).toBe('MARTIN Paul');
    expect(billingCall[1][1]).toBe('uuid-grp');
  });

  it('retourne 400 si le monitor cible a déjà un vol sur ce créneau', async () => {
    const fakeClient = {
      query:   jest.fn(),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValueOnce(fakeClient);

    fakeClient.query
      .mockResolvedValueOnce({ rows: [] })                                              // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, group_id: null, monitor_id: '2', start_time: '2026-06-15T10:00:00Z' }] }) // SELECT slot
      .mockResolvedValueOnce({ rows: [{ id: 5, status: 'booked', title: 'Marie' }] }) // SELECT target slot (occupé)
      .mockResolvedValueOnce({ rows: [] });                                            // ROLLBACK

    const res = await request(app)
      .patch('/api/slots/1/quick')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ monitor_id: '7' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vol prévu/);
  });
});
